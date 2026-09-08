/**
 * Részvény-tick motor (Fázis 3+4) — ELSŐ OSZTÁLYÚ, de a kripto `runTick`-től FÜGGETLEN.
 *
 * Miért külön: a részvény USD-ben számol és NAPI ritmusban dönt, a `runTick` viszont
 * USDT-denominált és óránkénti. A kettő egy hurokba erőltetése vagy hibás (USD↔USDT
 * keveredés egy ledgerben), vagy szétszedné a ledger pénznem-modelljét — kockáztatva a
 * működő kripto-botot. Ezért itt a KÖZÖS, generikus darabokat használjuk újra
 * (computeAllSignals, planProfitCycle, PaperExecutionBroker, executeIntent, risk-manager,
 * ledger), de saját USD-scope-pal és napi ütemmel.
 *
 * A döntés-agy TISZTA (planStockCycle); a végrehajtás INJEKTÁLHATÓ (runStockCycle),
 * ezért DB nélkül, memóriában is tesztelhető — pontosan úgy, ahogy a backtest teszi.
 */

import type { OhlcvCandle } from "@/lib/market/candles";
import { TIMEFRAME_MS } from "@/lib/market/candles";
import {
  computeAllSignals,
  planProfitCycle,
  type SymbolSignals,
  type ProfitCyclePlan,
  type SignalCandle,
} from "@/lib/engine/profit-cycle";
import { DEFAULT_STRATEGY, STRATEGY_VERSION, type StrategyConfig } from "@/lib/strategy/config";
import { PaperExecutionBroker } from "@/lib/execution/paper-broker";
import type { ExecutionBroker, ExecutionReceipt } from "@/lib/execution/broker";
import {
  executeIntent,
  type IntentRequest,
  type ExecuteIntentDeps,
} from "@/lib/engine/execute-intent";
import { DEFAULT_ORDER_RISK_PARAMS, originBudgetFor } from "@/lib/risk/risk-manager";
import { fillParamsForClass, stockSymbolFilters } from "@/lib/markets/execution";
import { stopCandidate } from "@/lib/engine/plan-exits";
import type { Instrument } from "@/lib/markets/registry";
import { etParts, etDateKey, usEquitySession, isUsTradingDay } from "@/lib/markets/calendar";
import { type LedgerState, positionQty, setStop } from "@/lib/portfolio/ledger";
import type { ExecutionIntent, Fill } from "@/lib/execution/contracts";
import { type Dec, ZERO, dec, div, mul, add, toNumber, isPositive } from "@/lib/portfolio/money";

/** A részvény-ág elszámoló pénzneme és időkerete. */
export const STOCK_QUOTE = "USD";
export const STOCK_STEP_MS = TIMEFRAME_MS["1d"];
/** A részvény paper-portfólió külön hatóköre (nem keveredik a kripto ledgerrel). */
export const STOCK_PORTFOLIO_ID = "stock-paper";

// ── Cadence: a részvény NAPI ritmusban dönt, a lezárt napi gyertya után ──────────

export interface StockDecisionGate {
  due: boolean;
  /** Az a kereskedési nap (ET dátum), amelyre a döntés vonatkozik. */
  decisionDate: string | null;
  reason: "after-hours" | "market-open" | "pre-market" | "weekend" | "holiday" | "already-ran";
}

/**
 * Esedékes-e MOST a részvény-döntés. A napi bar akkor végleges, ha az ülés lezárult
 * (after-hours), ezért a döntést a záró UTÁN, naponta EGYSZER hozzuk meg. A `lastDecisionDate`
 * (előző döntés ET-dátuma) megakadályozza, hogy ugyanarra a napra kétszer fussunk.
 */
export function stockDecisionDue(nowMs: number, lastDecisionDate: string | null): StockDecisionGate {
  const session = usEquitySession(nowMs);
  const today = etDateKey(etParts(nowMs));
  if (session.reason !== "after-hours") {
    const reason =
      session.reason === "regular-session"
        ? "market-open"
        : (session.reason as "pre-market" | "weekend" | "holiday");
    return { due: false, decisionDate: null, reason };
  }
  if (lastDecisionDate === today) return { due: false, decisionDate: today, reason: "already-ran" };
  return { due: true, decisionDate: today, reason: "after-hours" };
}

// ── Döntés-agy (TISZTA) ─────────────────────────────────────────────────────────

export interface StockPosition {
  id: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice: number;
}

export interface PlanStockCycleInput {
  /** Napi, LEZÁRT gyertyák symbolonként (idő szerint rendezve). */
  candlesBySymbol: Record<string, OhlcvCandle[]>;
  positions: StockPosition[];
  totalEquityUsd: number;
  weeklyBudgetRemainingUsd: number;
  /**
   * Piaci hangulat. A részvény-ágnak nincs kripto Fear&Greed jele, ezért alapból null —
   * a fear-kapus DCA így nem aktivál (a trend/momentum belépő viszont igen).
   */
  fearGreedValue?: number | null;
  strategy?: StrategyConfig;
}

export interface PlanStockCycleResult {
  plan: ProfitCyclePlan;
  signals: Record<string, SymbolSignals>;
  /** A legutolsó napi záróár symbolonként (a végrehajtási referencia). */
  lastClose: Record<string, number>;
  atrBySymbol: Record<string, number>;
}

/** Egy ET-dátumkulcs „déli" ms-e — a naptár-lekérdezésekhez (EST/EDT alatt is ugyanaz a nap). */
function noonEtMs(dateKey: string): number {
  return Date.parse(`${dateKey}T17:00:00Z`);
}

/** Az adott ET-nap ELŐTTI legutóbbi kereskedési nap dátumkulcsa. */
export function previousTradingDayKey(dateKey: string): string {
  let ms = noonEtMs(dateKey) - 24 * 60 * 60 * 1000;
  // Leghosszabb reális szünet: hosszú hétvége ünneppel — 10 nap bőven fedi.
  for (let i = 0; i < 10; i++) {
    if (isUsTradingDay(ms)) break;
    ms -= 24 * 60 * 60 * 1000;
  }
  return etDateKey(etParts(ms));
}

/**
 * Napi részvény-gyertyák UNIFORM rácsra vetítése a jel-számításhoz.
 *
 * Miért kell: a `computeSymbolSignals` a hézagot FIX ms-távolsággal méri (a kripto 1h
 * bar pontosan 3 600 000 ms-enként jön). A napi részvény-bar naptári távolsága viszont
 * hétvégén 3 nap, ünnepnapon 4, DST-váltáskor pedig ±1 óra — így a részvény-sor MINDIG
 * „réses" lenne, `sufficient: false`, és a sáv soha nem lépne be.
 *
 * A hézagot ezért a NAPTÁR dönti el (két egymást követő kereskedési nap), az openTime
 * pedig szintetikus rács: egymást követő ülés → +1 lépés, VALÓDI kimaradt kereskedési
 * nap → +2 lépés, ami a `contiguousTail`-t helyesen vágja el. A szintetikus idő CSAK a
 * jel-számításé; a végrehajtás a valódi gyertyák záróárával dolgozik.
 */
export function toSignalCandles(candles: OhlcvCandle[]): SignalCandle[] {
  const out: SignalCandle[] = [];
  let t = 0;
  let prevKey: string | null = null;
  for (const c of candles) {
    const key = etDateKey(etParts(c.openTime));
    if (prevKey !== null) {
      t += previousTradingDayKey(key) === prevKey ? STOCK_STEP_MS : 2 * STOCK_STEP_MS;
    }
    out.push({ openTime: t, high: c.high, low: c.low, close: c.close });
    prevKey = key;
  }
  return out;
}

/**
 * A részvény döntés-terve tisztán: napi gyertyák → jelek (computeAllSignals) →
 * profit-ciklus (planProfitCycle). Pontosan ugyanaz a stratégiai gép, amit a kripto
 * kód-alapú ága használ; a különbség csak az adat (napi részvény) és a lépésköz.
 */
export function planStockCycle(input: PlanStockCycleInput): PlanStockCycleResult {
  const strategy = input.strategy ?? DEFAULT_STRATEGY;

  const signalCandles: Record<string, SignalCandle[]> = {};
  const lastClose: Record<string, number> = {};
  const changePct: { symbol: string; change24hPct: number }[] = [];
  const latestBand: Record<string, { low: number; high: number; close: number }> = {};

  for (const [symbol, candles] of Object.entries(input.candlesBySymbol)) {
    if (candles.length === 0) continue;
    signalCandles[symbol] = toSignalCandles(candles);
    const last = candles[candles.length - 1];
    lastClose[symbol] = last.close;
    latestBand[symbol] = { low: last.low, high: last.high, close: last.close };
    if (candles.length >= 2) {
      const prev = candles[candles.length - 2].close;
      if (prev > 0) changePct.push({ symbol, change24hPct: (last.close / prev - 1) * 100 });
    }
  }

  const signals = computeAllSignals(signalCandles, strategy, STOCK_STEP_MS);
  const atrBySymbol: Record<string, number> = {};
  const trendOkBySymbol: Record<string, boolean> = {};
  const momentumOkBySymbol: Record<string, boolean> = {};
  for (const [sym, sig] of Object.entries(signals)) {
    atrBySymbol[sym] = sig.atr;
    trendOkBySymbol[sym] = sig.trendOk;
    momentumOkBySymbol[sym] = sig.momentumOk;
  }

  // A birtokolt pozíciók gyertyája kell a stop/TP-hez; ha nincs friss gyertya, kimarad.
  const posCandles: Record<string, { low: number; high: number; close: number }> = {};
  for (const p of input.positions) {
    if (latestBand[p.symbol]) posCandles[p.symbol] = latestBand[p.symbol];
  }

  const plan = planProfitCycle(
    {
      positions: input.positions,
      candles: posCandles,
      fearGreedValue: input.fearGreedValue ?? null,
      coinChanges: changePct,
      weeklyBudgetRemainingUsd: input.weeklyBudgetRemainingUsd,
      totalEquity: input.totalEquityUsd,
      atrBySymbol,
      trendOkBySymbol,
      momentumOkBySymbol,
    },
    strategy,
  );

  return { plan, signals, lastClose, atrBySymbol };
}

// ── Végrehajtás (INJEKTÁLHATÓ) ───────────────────────────────────────────────────

export interface StockCycleAction {
  kind: "stop-loss" | "take-profit" | "dca" | "momentum";
  side: "BUY" | "SELL";
  symbol: string;
  amountUsd: number;
  qty: number;
}

export interface RunStockCycleDeps {
  tickId: string;
  now: () => number;
  strategy?: StrategyConfig;
  strategyVersion?: string;
  /** A részvény ledger (USD). A hívó tartja; a fillek ezt frissítik. */
  ledger: LedgerState;
  /** Az aktív, kereskedhető részvény-instrumentumok. */
  instruments: Instrument[];
  candlesBySymbol: Record<string, OhlcvCandle[]>;
  weeklyBudgetRemainingUsd?: number;
  fearGreedValue?: number | null;
  positionIdBySymbol?: Record<string, string>;
  /** Opcionális perzisztencia — kihagyva memóriában (backteszt / demó / teszt) fut. */
  reserve?: ExecuteIntentDeps["reserve"];
  releaseReservation?: ExecuteIntentDeps["releaseReservation"];
  recordIntent?: ExecuteIntentDeps["recordIntent"];
  persist?: ExecuteIntentDeps["persist"];
  /** Opcionális stop-perzisztálás (trailing ratchet). */
  persistStop?: (symbol: string, stopPrice: Dec) => Promise<void>;
  /** Broker felülírás (teszt). Alap: PaperExecutionBroker USD/stock-paraméterekkel. */
  broker?: ExecutionBroker;
}

export interface RunStockCycleResult {
  ledger: LedgerState;
  actions: StockCycleAction[];
  signals: Record<string, SymbolSignals>;
  plan: ProfitCyclePlan;
  lastClose: Record<string, number>;
}

/**
 * A részvény profit-ciklus végrehajtása a KÖZÖS úton (risk-manager + executeIntent +
 * PaperExecutionBroker), USD-scope-ban. Perzisztencia nélkül memóriában fut.
 */
export async function runStockCycle(deps: RunStockCycleDeps): Promise<RunStockCycleResult> {
  const now = deps.now;
  const strategy = deps.strategy ?? DEFAULT_STRATEGY;
  const strategyVersion = deps.strategyVersion ?? STRATEGY_VERSION;
  const positionIdBySymbol = deps.positionIdBySymbol ?? {};
  let ledger = deps.ledger;
  let weeklyRemaining = dec(deps.weeklyBudgetRemainingUsd ?? 0);

  const allowedSymbols = deps.instruments.map((i) => i.symbol);
  const pricesDec: Record<string, Dec> = {};
  for (const [symbol, candles] of Object.entries(deps.candlesBySymbol)) {
    if (candles.length > 0) pricesDec[symbol] = dec(candles[candles.length - 1].close);
  }

  // A napi close a végrehajtási ár (a backteszt konvenciója). A broker ezt kapja `last`-ként.
  const market = (symbol: string) => (pricesDec[symbol] ? { last: pricesDec[symbol] } : null);

  const pendingTrigger = new Map<string, { kind: "stop-loss" | "take-profit"; triggerPrice: Dec }>();
  const broker: ExecutionBroker =
    deps.broker ??
    new PaperExecutionBroker({
      getLedger: () => ledger,
      getMarket: market,
      now,
      getTrigger: (intent: ExecutionIntent) => pendingTrigger.get(intent.intentId) ?? null,
      params: {
        ...fillParamsForClass("stock"),
        filters: stockSymbolFilters("STOCK", STOCK_QUOTE, now()),
        nowMs: now(),
      },
    });

  const equityUsd = (): Dec => {
    let total = ledger.cash[STOCK_QUOTE] ?? ZERO;
    for (const p of Object.values(ledger.positions)) {
      const px = pricesDec[p.symbol];
      if (px) total = add(total, mul(p.qty, px));
    }
    return total;
  };

  let seq = 0;
  const makeDeps = (origin: IntentRequest["origin"]): ExecuteIntentDeps => ({
    portfolioId: ledger.portfolioId,
    mode: "paper",
    strategyVersion,
    broker,
    getLedger: () => ledger,
    getRiskContext: () => ({
      ledger,
      prices: pricesDec,
      reservedQuoteBySymbol: {},
      reservedQuoteTotal: ZERO,
      originBudgetQuote: originBudgetFor(origin, { weeklyDcaRemaining: weeklyRemaining }),
      dailyLossLatched: false,
      dayBaselineMissing: false,
      allowedSymbols,
      quoteAsset: STOCK_QUOTE,
    }),
    riskParams: {
      ...DEFAULT_ORDER_RISK_PARAMS,
      maxPositionPct: dec(strategy.maxPositionPct),
      maxConcurrentPositions: strategy.maxConcurrentPositions,
    },
    now,
    newIntentId: () => `${deps.tickId}-stock-${origin}-${++seq}`,
    reserve: deps.reserve,
    releaseReservation: deps.releaseReservation,
    recordIntent: deps.recordIntent,
    persist: deps.persist,
  });

  const runIntent = async (req: IntentRequest): Promise<Fill | null> => {
    const d = makeDeps(req.origin);
    if (req.trigger) {
      const orig = d.newIntentId;
      d.newIntentId = () => {
        const id = orig();
        pendingTrigger.set(id, req.trigger!);
        return id;
      };
    }
    const outcome = await executeIntent(req, d);
    if (outcome.status === "executed") {
      ledger = outcome.ledger;
      return outcome.fills[0] ?? null;
    }
    return null;
  };

  const positions: StockPosition[] = Object.values(ledger.positions).map((p) => ({
    id: positionIdBySymbol[p.symbol] ?? p.symbol,
    symbol: p.symbol,
    qty: toNumber(p.qty),
    entryPrice: isPositive(p.qty) ? toNumber(div(p.costBasisQuote, p.qty)) : 0,
    stopPrice: p.stopPrice ? toNumber(p.stopPrice) : 0,
  }));

  const planned = planStockCycle({
    candlesBySymbol: deps.candlesBySymbol,
    positions,
    totalEquityUsd: toNumber(equityUsd()),
    weeklyBudgetRemainingUsd: deps.weeklyBudgetRemainingUsd ?? 0,
    fearGreedValue: deps.fearGreedValue ?? null,
    strategy,
  });

  // Trailing ratchet: a stop CSAK felfelé kúszik.
  for (const u of planned.plan.stopUpdates) {
    const symbol = positions.find((p) => p.id === u.positionId)?.symbol;
    if (!symbol) continue;
    ledger = setStop(ledger, symbol, dec(u.newStop));
    if (deps.persistStop) await deps.persistStop(symbol, dec(u.newStop));
  }

  const actions: StockCycleAction[] = [];
  // A SELL-ek előbb (a felszabaduló cash a DCA/momentum belépőnek hasznosul).
  const ordered = [
    ...planned.plan.orders.filter((o) => o.side === "SELL"),
    ...planned.plan.orders.filter((o) => o.side === "BUY"),
  ];
  for (const o of ordered) {
    const px = pricesDec[o.symbol];
    if (!px) continue;
    const fill =
      o.side === "SELL"
        ? await runIntent({
            side: "SELL",
            symbol: o.symbol,
            baseQty: dec(o.qty ?? 0),
            origin: o.kind,
            referencePrice: px,
            trigger:
              o.kind === "stop-loss" || o.kind === "take-profit"
                ? { kind: o.kind, triggerPrice: dec(o.triggerPrice ?? toNumber(px)) }
                : undefined,
          })
        : await runIntent({
            side: "BUY",
            symbol: o.symbol,
            desiredQuote: dec(o.amountUsd ?? 0),
            origin: o.kind,
            referencePrice: px,
            stopPrice: stopCandidate(px, dec(planned.atrBySymbol[o.symbol] ?? 0), strategy),
          });
    if (!fill) continue;
    actions.push({
      kind: o.kind,
      side: o.side,
      symbol: o.symbol,
      amountUsd: toNumber(fill.grossQuoteAmount),
      qty: toNumber(fill.filledBaseQty),
    });
    if (o.side === "BUY" && o.kind === "dca") {
      weeklyRemaining = add(weeklyRemaining, mul(fill.grossQuoteAmount, "-1"));
    }
  }

  return { ledger, actions, signals: planned.signals, plan: planned.plan, lastClose: planned.lastClose };
}

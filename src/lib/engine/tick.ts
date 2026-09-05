import { collectAll, type DataCollector } from "@/lib/collectors/base";
import { CoinGeckoCollector } from "@/lib/collectors/coingecko";
import { CryptoPanicCollector } from "@/lib/collectors/cryptopanic";
import { WhaleAlertCollector } from "@/lib/collectors/whalealert";
import { RSSCollector } from "@/lib/collectors/rss";
import { BinanceOHLCCollector } from "@/lib/collectors/binance";
import { FearGreedCollector } from "@/lib/collectors/feargreed";
import { RedditCollector } from "@/lib/collectors/reddit";
import { buildFeaturesWithDiagnostics } from "@/lib/ml/features";
import { predictWithStatus } from "@/lib/ml/predictor";
import { shouldDecide } from "@/lib/llm/phase1-filter";
import { decide } from "@/lib/llm/phase2-decide";
import { applyRisk, riskContextFromLedger, originBudgetFor, DEFAULT_ORDER_RISK_PARAMS } from "@/lib/risk/risk-manager";
import { PaperExecutionBroker } from "@/lib/execution/paper-broker";
import { BinanceBroker, BinanceLegacyExecutionAdapter } from "@/lib/execution/binance-broker";
import type { ExecutionBroker } from "@/lib/execution/broker";
import type { Fill } from "@/lib/execution/contracts";
import { COIN_UNIVERSE, RISK_LIMITS, RSS_SOURCES, REDDIT_SOURCES } from "@/lib/config";
import { loadPortfolioState, applyTrade, setStopPrice } from "@/lib/portfolio/accounting";
import { buildTickProcess } from "@/lib/engine/tick-process";
import { getPerformanceSummary } from "@/lib/portfolio/evaluate";
import { remainingWeeklyBudget } from "@/lib/strategy/weekly-budget";
import { planProfitCycle } from "@/lib/engine/profit-cycle";
import { DEFAULT_STRATEGY, STRATEGY_VERSION } from "@/lib/strategy/config";
import { computeAtr } from "@/lib/strategy/atr";
import { passesTrendFilter } from "@/lib/strategy/entry-filter";
import { passesMomentum } from "@/lib/strategy/momentum";
import { executeIntent, type ExecuteIntentDeps, type IntentRequest } from "@/lib/engine/execute-intent";
import {
  loadLedgerState,
  hasLedgerState,
  loadReservations,
  reserveBudget,
  releaseReservation,
  recordIntent,
  persistFill,
  persistStopPrice,
  seedLedger,
  expireStaleReservations,
} from "@/lib/execution/order-store";
import {
  emptyLedger,
  cashOf,
  equityAt,
  positionQty,
  setStop,
  type LedgerState,
} from "@/lib/portfolio/ledger";
import { type Dec, ZERO, add, div, mul, dec, toNumber, isPositive } from "@/lib/portfolio/money";
import { resolveDayGate, sinceInceptionPnlPct, type DayGateResult } from "@/lib/portfolio/day-equity";
import type { Decision, Trade, DataPoint, RawDecision } from "@/lib/types";

export interface TickInput {
  tickId: string; // YYYY-MM-DD-HH
  paperMode: boolean;
}

/** Egy kód-alapú profit-ciklus akció (stop-loss / take-profit / DCA). */
export interface CycleAction {
  kind: "stop-loss" | "take-profit" | "dca" | "momentum";
  side: "BUY" | "SELL";
  symbol: string;
  /** SELL-nél a végrehajtás után töltődik (terv-állapotban hiányozhat). */
  amountUsd?: number;
  /** BUY-nál a végrehajtás után töltődik (terv-állapotban hiányozhat). */
  qty?: number;
}

export interface TickResult {
  events: DataPoint[];
  decision: Decision;
  trade: Trade | null;
  /** Ha a trade DB-be lett perzisztálva, a pozíció id-ja; null ha nem volt DB. */
  positionId?: string | null;
  /** A Risk Manager ELŐTTI eredeti döntés (risk_overrides naplózáshoz, ha overridden). */
  rawAction: RawDecision["action"];
  rawAmountPct: number;
  /** Aktuális árak symbolonként (a döntés ref-jéhez + utólagos kiértékeléshez). */
  prices: Record<string, number>;
  /**
   * A kód-alapú profit-ciklus által végrehajtott akciók (az AI-lánc ELŐTT futnak).
   * Üres tömb, ha nem volt DB/pozíció vagy nem volt teendő. Lásd profit-cycle spec §2.
   */
  cycleActions: CycleAction[];
  /** A tick teljes folyamat-pillanatképe (átláthatóság, tick_runs napló). */
  process: import("@/lib/engine/tick-process").TickProcess;
  /**
   * Igaz, ha a tick ténylegesen KÖTHETETT volna (volt hiteles portfólió-állapot).
   * Hamis esetén a döntés naplózódik, de order SOHA nem megy ki.
   */
  tradingEnabled: boolean;
  /** A napi veszteségkapu állapota (referencia-forrás, napi hozam, latch). */
  dayGate: {
    dayUtc: string;
    source: string;
    dayPnlPct: number | null;
    latched: boolean;
    blockNewBuys: boolean;
    reason: string;
  };
  /** Az INDULÁS ÓTA mért hozam — külön mutató, nem a napi kapu bemenete. */
  inceptionPnlPct: number | null;
  /** Az ML-modell állapota és a kihagyott feature-ök (adathiány láthatósága). */
  ml: {
    modelUsable: boolean;
    modelDetail: string | null;
    signalCount: number;
    skipped: { symbol: string; reason: string }[];
  };
}

/** Szimulált díj — egyezik a paper fill-modellel (0.1%). */
const PAPER_FEE_PCT = 0.001;

/** A Fill visszafordítása a régi Trade alakra (a v1 perzisztencia és a UI kedvéért). */
function fillToTrade(fill: Fill, origin: CycleAction["kind"] | "ai"): Trade {
  return {
    id: fill.fillId,
    orderId: fill.exchangeOrderId,
    symbol: fill.symbol,
    side: fill.side,
    amountUsd: toNumber(fill.grossQuoteAmount),
    price: toNumber(fill.fillPrice),
    qty: toNumber(fill.filledBaseQty),
    feeUsd: toNumber(fill.feeAmount),
    executedAt: fill.executedAt,
    mode: fill.mode,
    origin,
  };
}

/**
 * A teljes óránkénti ciklus vezérlője. Lásd spec §4.
 *
 * V2 (T06): MINDEN order — AI, DCA, momentum, stop-loss, take-profit — ugyanazon a
 * kockázati kapun és ugyanazon a fill-könyvelőn megy át (execute-intent).
 *
 * FONTOS: ha nincs hiteles portfólió-állapot (nincs DB vagy nincs inicializált portfólió),
 * a tick NEM kereskedik. A régi 10 000 USD fallback tőke eltűnt: hiányzó DB nem
 * aktiválhat valódi ordert (audit + terv §3).
 *
 * Lépések:
 *  1) Portfólió-állapot betöltése és v2 ledgerré alakítása
 *  2) Data Collectors → events
 *  3) Kód-alapú profit-ciklus (stop/TP/trailing/DCA/momentum) a közös úton
 *  4) ML feature + predict → mlSignals
 *  5) Phase-1, majd szükség esetén Phase-2 (LLM)
 *  6) Risk Manager (döntés-szinten) + végrehajtás a közös úton
 */
export async function runTick(input: TickInput): Promise<TickResult> {
  const mode = input.paperMode ? "paper" : "live";
  const dbState = await loadPortfolioState();

  // ── 1) Ledger. DB nélkül NINCS kereskedés. ────────────────────────────────
  //     Az igazságforrás a v2 ledger (ledger_cash + ledger_positions). Ha ez a hatókör
  //     még üres, EGYSZER feltöltjük a v1 portfólió-állapotból; a teljes, jelentéssel
  //     kísért migráció a T11.
  const portfolioId = dbState?.portfolioId ?? "no-portfolio";
  const scope = { portfolioId, mode } as const;
  let ledger: LedgerState = emptyLedger(portfolioId, mode, ZERO);
  /** A v1 positions sorok id-ja symbolonként — a régi olvasók vetületéhez kell. */
  const positionIdBySymbol: Record<string, string> = {};
  const tradingEnabled = dbState !== null;

  if (dbState) {
    for (const p of dbState.positions) {
      if (p.qty > 0) positionIdBySymbol[p.symbol] = p.id;
    }
    if (!(await hasLedgerState(scope))) {
      await seedLedger(
        scope,
        dec(dbState.cashUsd),
        dbState.positions
          .filter((p) => p.qty > 0)
          .map((p) => ({
            symbol: p.symbol,
            qty: dec(p.qty),
            costBasisQuote: mul(dec(p.qty), dec(p.entryPrice)),
            stopPrice: p.stopPrice > 0 ? dec(p.stopPrice) : null,
          })),
      );
      console.warn("[tick] a v2 ledger üres volt — feltöltve a v1 portfólió-állapotból (T11 elvégzi a teljes migrációt).");
    }
    ledger = await loadLedgerState(scope);
    await expireStaleReservations(scope);
  }

  // ── 2) Collectors ─────────────────────────────────────────────────────────
  const collectors: DataCollector[] = [
    new CoinGeckoCollector([...COIN_UNIVERSE]),
    new BinanceOHLCCollector([...COIN_UNIVERSE]),
    new RSSCollector(RSS_SOURCES),
    new FearGreedCollector(),
  ];
  if (process.env.CRYPTOPANIC_TOKEN)
    collectors.push(new CryptoPanicCollector(process.env.CRYPTOPANIC_TOKEN, [...COIN_UNIVERSE]));
  if (process.env.WHALEALERT_KEY)
    collectors.push(new WhaleAlertCollector(process.env.WHALEALERT_KEY, [...COIN_UNIVERSE]));
  if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET)
    collectors.push(
      new RedditCollector(process.env.REDDIT_CLIENT_ID, process.env.REDDIT_CLIENT_SECRET, REDDIT_SOURCES),
    );

  const events = await collectAll(collectors);
  const llmEvents = events.filter((e) => e.source !== "binance");

  // Aktuális ár symbolonként (a legfrissebb price-pont).
  const prices: Record<string, number> = {};
  const pricesDec: Record<string, Dec> = {};
  const latestTs: Record<string, number> = {};
  for (const e of events) {
    if (e.kind === "price" && e.price && (latestTs[e.symbol] === undefined || e.timestamp > latestTs[e.symbol])) {
      latestTs[e.symbol] = e.timestamp;
      prices[e.symbol] = e.price.usd;
      pricesDec[e.symbol] = dec(e.price.usd);
    }
  }

  const equityNow = (): Dec => equityAt(ledger, pricesDec);

  // ── Napi veszteségkapu (T07). A régi kód az INDULÁS ÓTA mért hozamot használta;
  //    itt UTC napkezdő referencia, pénzmozgás-korrekció és napi latch dolgozik.
  //    Ha egy BIRTOKOLT coin ára hiányzik, az equity nem mérhető → nincs kitalált
  //    napi hozam, és az új vétel szünetel (a SELL nem).
  const heldWithoutPrice = Object.keys(ledger.positions).filter((s) => pricesDec[s] === undefined);
  const measurableEquity = heldWithoutPrice.length === 0 ? equityNow() : null;
  const dayGate: DayGateResult = tradingEnabled
    ? await resolveDayGate(
        portfolioId,
        mode,
        measurableEquity,
        dec(RISK_LIMITS.dailyLossCircuitBreakerPct),
        Date.now(),
      )
    : {
        dayUtc: "",
        row: { dayUtc: "", baselineEquity: ZERO, cashFlowQuote: ZERO, source: "missing", lossLatched: false, latchedAt: null },
        dayPnlPct: null,
        latched: false,
        blockNewBuys: true,
        reason: "Nincs hiteles portfólió-állapot.",
        needsPersist: false,
      };
  /** Az indulás óta mért hozam KÜLÖN mutató — nem a napi kapu bemenete. */
  const inceptionPnlPct = dbState ? sinceInceptionPnlPct(equityNow(), dec(dbState.initialCapitalUsd)) : null;

  // ── Végrehajtási függőségek (a broker CSAK jóváhagyott intentet kaphat) ────
  /** A stop/TP trigger az intentId-hoz kötve (a paper fill-modellnek). */
  const pendingTrigger = new Map<string, { kind: "stop-loss" | "take-profit"; triggerPrice: Dec }>();

  const market = (symbol: string) => (pricesDec[symbol] ? { last: pricesDec[symbol] } : null);
  const broker: ExecutionBroker = input.paperMode
    ? new PaperExecutionBroker({
        getLedger: () => ledger,
        getMarket: market,
        now: () => Date.now(),
        getTrigger: (intent) => pendingTrigger.get(intent.intentId) ?? null,
        params: { feePct: dec(PAPER_FEE_PCT), slippageBps: 5, spreadBps: 2, quoteAsset: "USDT" },
      })
    : new BinanceLegacyExecutionAdapter(
        new BinanceBroker(process.env.BINANCE_API_KEY ?? "", process.env.BINANCE_API_SECRET ?? ""),
        RISK_LIMITS.stopLossPct,
      );

  // Az aktív foglalások: két párhuzamos futó nem költheti el ugyanazt a keretet.
  const reservations = tradingEnabled ? await loadReservations(scope) : { bySymbol: {}, total: ZERO };

  let weeklyRemaining: Dec | undefined;
  let intentSeq = 0;

  const makeDeps = (origin: IntentRequest["origin"]): ExecuteIntentDeps => ({
    portfolioId,
    mode,
    strategyVersion: STRATEGY_VERSION,
    broker,
    getLedger: () => ledger,
    getRiskContext: () => ({
      ledger,
      prices: pricesDec,
      reservedQuoteBySymbol: reservations.bySymbol,
      reservedQuoteTotal: reservations.total,
      originBudgetQuote: originBudgetFor(origin, { weeklyDcaRemaining: weeklyRemaining }),
      dailyLossLatched: dayGate.latched,
      dayBaselineMissing: dayGate.dayPnlPct === null,
      allowedSymbols: [...COIN_UNIVERSE],
      quoteAsset: "USDT",
    }),
    riskParams: {
      ...DEFAULT_ORDER_RISK_PARAMS,
      maxPositionPct: dec(RISK_LIMITS.maxPositionPct),
      maxConcurrentPositions: RISK_LIMITS.maxConcurrentPositions,
    },
    now: () => Date.now(),
    newIntentId: () => `${input.tickId}-${origin}-${++intentSeq}`,
    // Keretfoglalás a beküldés ELŐTT. A fedezet-ellenőrzést a SZERVER végzi, ezért két
    // egyidejű BUY sem lépheti át ugyanazt a keretet.
    reserve: async (intent, quote) => {
      if (!dbState) return false;
      return reserveBudget(intent, quote, cashOf(ledger, "USDT"));
    },
    releaseReservation: async (intent) => {
      if (dbState) await releaseReservation(intent.intentId);
    },
    recordIntent: async (intent, receipt) => {
      if (dbState) await recordIntent(intent, receipt);
    },
    // EGY tranzakciós út: fill + cash + pozíció + foglalás együtt commitol vagy bukik.
    // Hiba esetén DOB — nincs log-és-továbbmegy hamis siker (audit A. szakasz).
    persist: async (intent, fill, deltas) => {
      if (!dbState) return;
      await persistFill(intent, fill, deltas);
      // A v1 táblák innentől CSAK VETÜLET a régi dashboard-olvasóknak (a T23 vezeti ki).
      // A hibája nem buktatja a ticket, mert nem igazságforrás — de hangosan látszik.
      try {
        const trade = fillToTrade(fill, origin === "ai" ? "ai" : (origin as CycleAction["kind"]));
        const stopPrice =
          fill.side === "BUY"
            ? toNumber(mul(fill.fillPrice, dec(1 - RISK_LIMITS.stopLossPct)))
            : toNumber(fill.fillPrice);
        const persisted = await applyTrade(trade, stopPrice);
        if (persisted?.positionId) positionIdBySymbol[fill.symbol] = persisted.positionId;
      } catch (e) {
        console.error("[tick] a v1 vetület írása nem sikerült (a v2 ledger már commitolt):", e);
      }
    },
  });

  /** Egy order végrehajtása a közös úton. Visszaadja a fillt, vagy null-t. */
  const runIntent = async (req: IntentRequest): Promise<Fill | null> => {
    if (!tradingEnabled) return null;
    const deps = makeDeps(req.origin);
    if (req.trigger) {
      // A trigger az intentId-hoz kötődik; az azonosítót a deps generálja.
      const originalNewId = deps.newIntentId;
      deps.newIntentId = () => {
        const id = originalNewId();
        pendingTrigger.set(id, req.trigger!);
        return id;
      };
    }
    const outcome = await executeIntent(req, deps);
    if (outcome.status === "executed") {
      ledger = outcome.ledger;
      return outcome.fills[0] ?? null;
    }
    if (outcome.status === "unknown") {
      console.error("[tick] ismeretlen order-állapot, egyeztetés szükséges:", outcome.message);
    }
    return null;
  };

  // ── 3) Kód-alapú profit-ciklus ────────────────────────────────────────────
  const cycleActions: CycleAction[] = [];

  if (tradingEnabled) {
    weeklyRemaining = await remainingWeeklyBudget(equityNow(), { portfolioId, mode }, Date.now());

    const fgEvent = events.find((e) => e.kind === "sentiment" && e.sentiment);
    const fearGreedValue = fgEvent?.sentiment?.value ?? null;
    const coinChanges = events
      .filter(
        (e) =>
          e.source === "coingecko" &&
          e.kind === "price" &&
          e.price !== undefined &&
          (COIN_UNIVERSE as readonly string[]).includes(e.symbol),
      )
      .map((e) => ({ symbol: e.symbol, change24hPct: e.price!.change24hPct }));

    // Live candle-band: low=high=close=aktuális ár (csak a spot ismert).
    const candles: Record<string, { low: number; high: number; close: number }> = {};
    for (const symbol of Object.keys(ledger.positions)) {
      const px = prices[symbol];
      if (px !== undefined) candles[symbol] = { low: px, high: px, close: px };
    }

    const ohlcBySymbol: Record<string, { high: number; low: number; close: number }[]> = {};
    for (const e of events) {
      if (e.source === "binance" && e.kind === "price" && e.price) {
        (ohlcBySymbol[e.symbol] ??= []).push({ high: e.price.usd, low: e.price.usd, close: e.price.usd });
      }
    }
    const atrBySymbol: Record<string, number> = {};
    const trendOkBySymbol: Record<string, boolean> = {};
    const momentumOkBySymbol: Record<string, boolean> = {};
    for (const sym of COIN_UNIVERSE) {
      const buf = ohlcBySymbol[sym] ?? [];
      atrBySymbol[sym] = computeAtr(buf, DEFAULT_STRATEGY.atrPeriod);
      const closes = buf.map((b) => b.close);
      trendOkBySymbol[sym] = passesTrendFilter(closes, DEFAULT_STRATEGY.entryFilterSmaPeriod);
      momentumOkBySymbol[sym] = passesMomentum(closes, DEFAULT_STRATEGY.momentumSmaPeriod, DEFAULT_STRATEGY.momentumLookback);
    }

    const plan = planProfitCycle(
      {
        positions: Object.values(ledger.positions).map((p) => ({
          id: positionIdBySymbol[p.symbol] ?? p.symbol,
          symbol: p.symbol,
          qty: toNumber(p.qty),
          entryPrice: isPositive(p.qty) ? toNumber(div(p.costBasisQuote, p.qty)) : 0,
          stopPrice: p.stopPrice ? toNumber(p.stopPrice) : 0,
        })),
        candles,
        fearGreedValue,
        coinChanges,
        weeklyBudgetRemainingUsd: toNumber(weeklyRemaining),
        totalEquity: toNumber(equityNow()),
        atrBySymbol,
        trendOkBySymbol,
        momentumOkBySymbol,
      },
      DEFAULT_STRATEGY,
    );

    // Trailing ratchet: a stop CSAK felfelé kúszik, és a rávásárlás sem viszi lejjebb.
    for (const u of plan.stopUpdates) {
      const symbol = Object.values(ledger.positions).find(
        (p) => (positionIdBySymbol[p.symbol] ?? p.symbol) === u.positionId,
      )?.symbol;
      if (!symbol) continue;
      ledger = setStop(ledger, symbol, dec(u.newStop));
      await persistStopPrice(scope, symbol, dec(u.newStop));
      // v1 vetület a régi olvasóknak.
      const dbId = positionIdBySymbol[symbol];
      if (dbId) await setStopPrice(dbId, u.newStop);
    }

    // A SELL-ek ELŐBB (a felszabaduló cash a DCA-nak hasznosul).
    const ordered = [...plan.orders.filter((o) => o.side === "SELL"), ...plan.orders.filter((o) => o.side === "BUY")];
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
              stopPrice: undefined,
            });
      if (!fill) continue;
      cycleActions.push({
        kind: o.kind,
        side: o.side,
        symbol: o.symbol,
        amountUsd: toNumber(fill.grossQuoteAmount),
        qty: toNumber(fill.filledBaseQty),
      });
      if (o.side === "BUY" && o.kind === "dca" && weeklyRemaining) {
        weeklyRemaining = add(weeklyRemaining, mul(fill.grossQuoteAmount, "-1"));
      }
    }
  }

  // ── 4) ML jelek. Inkompatibilis modell vagy hiányos ablak esetén NINCS jel —
  //     és ez LÁTHATÓ, nem néma nulla. Lásd T13.
  const featureResult = buildFeaturesWithDiagnostics(events);
  const prediction = predictWithStatus(featureResult.features);
  const mlSignals = prediction.signals;
  if (!prediction.status.usable) {
    console.warn(`[tick] ML-jel KIHAGYVA: ${prediction.status.detail}`);
  }
  for (const s of featureResult.skipped) {
    console.warn(`[tick] nincs ML-feature ${s.symbol}: ${s.reason}`);
  }

  // ── 5) Phase-1 / Phase-2 ──────────────────────────────────────────────────
  const phase1 = await shouldDecide(llmEvents);

  let phase2Snapshot: import("@/lib/engine/tick-process").TickProcess["phase2"] = null;
  let rawDecision: RawDecision = {
    action: "HOLD",
    symbol: "",
    amountPct: 0,
    confidence: 0.3,
    reasoning: phase1.summary,
    model: "phase1/glm-4-flash",
  };

  if (phase1.shouldDecide) {
    const performance = await getPerformanceSummary();
    const phase2 = await decide({
      events: llmEvents,
      mlSignals,
      // Az AI VALÓS belépési árat és pozícióértéket lát (a régi kód 0-t küldött).
      portfolio: {
        cashUsd: toNumber(cashOf(ledger, "USDT")),
        positions: Object.values(ledger.positions).map((p) => ({
          symbol: p.symbol,
          qty: toNumber(p.qty),
          entryPrice: isPositive(p.qty) ? toNumber(div(p.costBasisQuote, p.qty)) : 0,
        })),
      },
      performance: {
        actionable: performance.actionable,
        hitRate: performance.hitRate,
        avgHypotheticalPnlPct: performance.avgHypotheticalPnlPct,
      },
    });
    rawDecision = {
      action: phase2.action,
      symbol: phase2.symbol ?? "",
      amountPct: phase2.amountPct,
      confidence: phase2.confidence,
      reasoning: phase2.reasoning,
      model: process.env.LLM_MODEL_PHASE2 ?? "glm-5.2",
    };
    phase2Snapshot = {
      action: phase2.action,
      symbol: phase2.symbol ?? null,
      amountPct: phase2.amountPct,
      confidence: phase2.confidence,
      reasoning: phase2.reasoning,
    };
  }

  // ── 6) Döntés-szintű kapu + végrehajtás a KÖZÖS úton ──────────────────────
  const decision = applyRisk(
    rawDecision,
    riskContextFromLedger(ledger, pricesDec, {
      dayPnlPct: dayGate.dayPnlPct ?? undefined,
      dailyLossLatched: dayGate.latched,
      dayBaselineMissing: dayGate.dayPnlPct === null,
      allowedSymbols: [...COIN_UNIVERSE],
    }),
    {
      maxPositionPct: RISK_LIMITS.maxPositionPct,
      maxConcurrentPositions: RISK_LIMITS.maxConcurrentPositions,
      dailyLossCircuitBreakerPct: RISK_LIMITS.dailyLossCircuitBreakerPct,
    },
  );

  let trade: Trade | null = null;
  let positionId: string | null = null;
  if (tradingEnabled && decision.action !== "HOLD" && decision.symbol && pricesDec[decision.symbol]) {
    const px = pricesDec[decision.symbol];
    const fill =
      decision.action === "BUY"
        ? // BUY: a hányad a TELJES EQUITY-re vonatkozik (nem a készpénzre).
          await runIntent({
            side: "BUY",
            symbol: decision.symbol,
            desiredQuote: mul(equityNow(), dec(decision.amountPct)),
            origin: "ai",
            referencePrice: px,
          })
        : // SELL: a hányad a BIRTOKOLT MENNYISÉGRE vonatkozik — cash-független.
          await runIntent({
            side: "SELL",
            symbol: decision.symbol,
            baseQty: mul(positionQty(ledger, decision.symbol), dec(decision.amountPct)),
            origin: "ai",
            referencePrice: px,
          });
    if (fill) {
      trade = fillToTrade(fill, "ai");
      positionId = positionIdBySymbol[fill.symbol] ?? null;
    }
  }

  const fgForProcess = events.find((e) => e.kind === "sentiment" && e.sentiment)?.sentiment ?? null;
  const tickProcess = buildTickProcess({
    tickId: input.tickId,
    prices,
    fearGreed: fgForProcess ? { value: fgForProcess.value, classification: fgForProcess.classification } : null,
    mlSignals: mlSignals.map((s) => ({ symbol: s.symbol, direction1h: s.direction1h, confidence: s.confidence })),
    cycleActions,
    phase1: { shouldDecide: phase1.shouldDecide, summary: phase1.summary },
    phase2: phase2Snapshot,
    decision: {
      action: decision.action,
      symbol: decision.symbol || null,
      overridden: decision.overridden,
      overrideReason: decision.overrideReason ?? null,
    },
    aiTrade: trade ? { symbol: trade.symbol, side: trade.side, amountUsd: trade.amountUsd } : null,
  });

  return {
    events,
    decision,
    trade,
    positionId,
    rawAction: rawDecision.action,
    rawAmountPct: rawDecision.amountPct,
    prices,
    cycleActions,
    process: tickProcess,
    tradingEnabled,
    dayGate: {
      dayUtc: dayGate.dayUtc,
      source: dayGate.row.source,
      dayPnlPct: dayGate.dayPnlPct,
      latched: dayGate.latched,
      blockNewBuys: dayGate.blockNewBuys,
      reason: dayGate.reason,
    },
    inceptionPnlPct,
    ml: {
      modelUsable: prediction.status.usable,
      modelDetail: prediction.status.usable ? null : prediction.status.detail,
      signalCount: mlSignals.length,
      skipped: featureResult.skipped,
    },
  };
}

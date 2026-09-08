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

import type { OhlcvCandle, Timeframe } from "@/lib/market/candles";
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
import { fillParamsForClass, stockSymbolFilters, stockClosingFilters } from "@/lib/markets/execution";
import { stopCandidate } from "@/lib/engine/plan-exits";
import type { Instrument } from "@/lib/markets/registry";
import type { EntryShape } from "@/lib/strategy/intraday-entries";
import type { MomentumRanker } from "@/lib/strategy/momentum-ranking";
import { etParts, etDateKey, usEquitySession, isUsTradingDay, minutesToSessionClose } from "@/lib/markets/calendar";
import { type LedgerState, positionQty, setStop } from "@/lib/portfolio/ledger";
import type { ExecutionIntent, Fill } from "@/lib/execution/contracts";
import { type Dec, ZERO, dec, div, mul, add, toNumber, isPositive } from "@/lib/portfolio/money";

/**
 * A részvény-sáv stratégiája — a kripto `DEFAULT_STRATEGY`-ből, KÉT eltéréssel:
 *
 * 1) `momentumEnabled: true`. A kripto-ág fő belépője a fear-DCA, aminek a kapuja a
 *    Fear&Greed index ≤ 20 — a részvénynek NINCS ilyen jele (a sáv `fearGreedValue`-ja
 *    null), tehát a DCA sosem aktivál. A momentum-breakout az EGYETLEN belépő út itt;
 *    kikapcsolva a sáv örökre tétlen maradna (naponta 0 akció).
 * 2) `momentumBuyPct: 0.10`. A részvény EGÉSZ darabban kereskedik (a paper-fill
 *    konzervatív egész lotot enged csak), így a kripto 2%-os tétele 10 000 USD-n
 *    200 USD = 0 darab SPY (~770 USD) vagy NVDA (~230 USD) — minden belépő némán
 *    elhalna a kerekítésen. 10% ~1000 USD, ami 1 SPY / 4 NVDA.
 *
 * A kockázati keret VÁLTOZATLAN: 20% max pozíció, 3 egyidejű pozíció, 5% stop,
 * 10% take-profit, napi circuit breaker.
 */
export const STOCK_STRATEGY: StrategyConfig = {
  ...DEFAULT_STRATEGY,
  momentumEnabled: true,
  momentumBuyPct: 0.1,
};

/** A részvény-stratégia saját verzió-címkéje (a döntés-napló ezt rögzíti). */
export const STOCK_STRATEGY_VERSION = `${STRATEGY_VERSION}-stock-momentum10`;

/** A részvény-ág elszámoló pénzneme és időkerete. */
export const STOCK_QUOTE = "USD";
export const STOCK_STEP_MS = TIMEFRAME_MS["1d"];
/** A részvény paper-portfólió külön hatóköre (nem keveredik a kripto ledgerrel). */
export const STOCK_PORTFOLIO_ID = "stock-paper";
/**
 * A relatív-erő rangsor referencia-papírja. Ugyanaz, amit a rezsim-szűrő is néz: a
 * piac állapotát az S&P 500 ETF képviseli. Ha nincs az aktív univerzumban, a relatív
 * erő nyers változásra esik vissza (a rangsor ezt kezeli).
 */
export const MOMENTUM_BENCHMARK = "SPY";

/**
 * A napi veszteségkapu ÁLLAPOTA a ciklus szempontjából. Szándékosan minimális: a
 * `runStockCycle` nem tud (és nem is akar) DB-t olvasni — a hívó dönti el, honnan jön.
 */
/**
 * Meddig számít FRISSNEK a legutolsó lezárt gyertya (audit 2. pont).
 *
 * Miért kell: a jel és a végrehajtás UGYANABBÓL a lezárt gyertyából dolgozik, és a bar
 * lezártsága önmagában nem bizonyítja, hogy az ár MOST is érvényes. Ha a betöltés hibázik
 * vagy a cron kimarad, a sorozat belsőleg folytonos marad, csak épp RÉGI — enélkül a
 * rendszer egy tegnapi árra adna ki mai market ordert.
 *
 * Intraday: három bar (5 percen 15 perc) — egy kimaradt ciklus még belefér, kettő nem.
 * Napi: 36 óra, vagyis a tegnapi zárásnál régebbi adatból nincs új belépő.
 */
export function defaultMaxBarAgeMs(timeframe: Timeframe): number {
  return timeframe === "1d" ? 36 * 60 * 60 * 1000 : 3 * TIMEFRAME_MS[timeframe];
}

/**
 * Elavult gyertyasorú papírok a döntés idejéhez mérve. A `closeTime` a valódi zárás; ahol
 * nincs, a nyitás + időkeret a konzervatív becslés.
 */
export function staleSymbolsAt(
  candlesBySymbol: Record<string, OhlcvCandle[]>,
  nowMs: number,
  timeframe: Timeframe,
  maxBarAgeMs?: number,
): string[] {
  const maxAge = maxBarAgeMs ?? defaultMaxBarAgeMs(timeframe);
  const stepMs = TIMEFRAME_MS[timeframe];
  const out: string[] = [];
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    if (candles.length === 0) continue;
    const last = candles[candles.length - 1];
    const closedAt = last.closeTime ?? last.openTime + stepMs;
    if (nowMs - closedAt > maxAge) out.push(symbol);
  }
  return out.sort();
}

export interface StockDayGateState {
  /** Igaz, ha a napi veszteség-latch ma bekapcsolt → nincs ÚJ vétel a nap végéig. */
  latched: boolean;
  /** Igaz, ha nincs hiteles napkezdő equity-referencia → nincs ÚJ vétel. */
  baselineMissing: boolean;
}

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

// ── Day trading: intraday időkeret és ülés-fázisok ──────────────────────────────

/** A day-trading sáv gyertya-mérete. */
export const STOCK_INTRADAY_TF: Timeframe = "5m";

/**
 * A day-trading (intraday) stratégia — MÉRT paraméterekkel, nem tippelve.
 *
 * Forrás: `scripts/stock-intraday-backtest.ts`, 60 nap 5 perces Yahoo-gyertyán
 * (AAPL/MSFT/NVDA/SPY, 4681 bar/szimbólum), a LIVE úton (ugyanaz a döntés-agy, ugyanaz a
 * risk + paper-fill + egész részvény lot + díj/spread). Amit a mérés mondott:
 *
 *  - MINDEN szűk stop/TP variáns VESZTETT (stop 0,3-1% × TP 0,5-1,5%: −2,7%-tól −6,6%-ig),
 *    és annál rosszabb, minél szűkebb a stop, mert a zaj kirázza. Ugyanez az ATR-trailingre
 *    (x1 → −4,96%). A gyakori kereskedés itt is a költségen és a whipsaw-n bukik.
 *  - Ami POZITÍV: belépés a kitörésre, kilépés a nap végi laposra zárással. A stop marad
 *    katasztrófa-stop (5%), a TP 10% — intraday gyakorlatilag nem sülnek el.
 *  - A lassabb jel jobb: SMA 78 / lookback 156 bar (≈1, illetve 2 ülés) +1,08% / 60 nap,
 *    98 trade, 55% találat, 0,81% maxDD — és a 60 nap MINDKÉT felén pozitív
 *    (+0,39% / +0,68%), tehát nem egyetlen szerencsés ablak.
 *  - A 15 perces gyertya rosszabb (a legjobb variáns +0,40%).
 *
 * ŐSZINTE KERET: ugyanebben a 60 napban a puszta tartás SPY +5,9%, MSFT +27,7% volt. Ez a
 * sáv NEM veri a vételt-és-tartást egy emelkedő piacon; amit ad, az az alacsony drawdown
 * és a nulla overnight kockázat. A day trading itt kockázat-profil, nem hozam-ígéret.
 */
export const STOCK_INTRADAY_STRATEGY: StrategyConfig = {
  ...STOCK_STRATEGY,
  entryFilterSmaPeriod: 78,
  momentumSmaPeriod: 78,
  momentumLookback: 156,
};

/** A day-trading stratégia verzió-címkéje (a döntés-napló ezt rögzíti). */
export const STOCK_INTRADAY_STRATEGY_VERSION = `${STRATEGY_VERSION}-stock-intraday5m`;

/** Ennyi 5 perces bar kell a jelekhez (156 lookback + bemelegítés). */
export const STOCK_INTRADAY_BARS = 220;

/** Az utolsó ennyi percben már NEM nyitunk új pozíciót (nem érné el a célt zárásig). */
export const INTRADAY_ENTRY_CUTOFF_MIN = 30;
/** Az utolsó ennyi percben MINDENT laposra zárunk — nincs overnight kockázat. */
export const INTRADAY_FLATTEN_MIN = 10;

/** Mit csinálhat a ciklus MOST, az ülés állapota szerint. */
export type IntradayPhase = "closed" | "trading" | "no-new-entries" | "flatten";

export interface IntradayGate {
  /** Fusson-e egyáltalán a ciklus (zárt piacon nincs mit tenni). */
  due: boolean;
  phase: IntradayPhase;
  /** Hány perc van hátra a zárásig (null, ha nincs ülés). */
  minutesToClose: number | null;
  reason: string;
}

/**
 * A day-trading ciklus fázisa egy időpontban.
 *
 * A nap végi laposra zárás a day trading LÉNYEGE: a pozíció nem viheti át az éjszakai
 * gap-kockázatot. Ezért zárás előtt előbb leáll az új belépő (`no-new-entries`), majd
 * minden nyitott pozíció zárul (`flatten`).
 */
export function intradayPhaseAt(nowMs: number): IntradayGate {
  const session = usEquitySession(nowMs);
  if (!session.open) {
    return { due: false, phase: "closed", minutesToClose: null, reason: session.reason };
  }
  const left = minutesToSessionClose(nowMs) ?? 0;
  if (left <= INTRADAY_FLATTEN_MIN) {
    return { due: true, phase: "flatten", minutesToClose: left, reason: "eod-flat" };
  }
  if (left <= INTRADAY_ENTRY_CUTOFF_MIN) {
    return { due: true, phase: "no-new-entries", minutesToClose: left, reason: "entry-cutoff" };
  }
  return { due: true, phase: "trading", minutesToClose: left, reason: "regular-session" };
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
  /** A gyertyák időkerete. Napi swing: "1d"; day trading: "5m". */
  timeframe?: Timeframe;
  /**
   * Cserélhető BELÉPŐ-alak. Ha megadod, EZ dönti el symbolonként a belépő engedélyét a
   * beépített kitörés-jel helyett (a hézag-kapu, a méretezés és a kilépés változatlan).
   * Élesben alapból üres — a scripts/stock-intraday-backtest.ts --sweep shape méri.
   */
  entryShape?: EntryShape;
  /**
   * Cserélhető MOMENTUM-RANGSOR: több jogosult papír közül melyik nyer. Üresen a nyers
   * százalék-maximum dönt (mai viselkedés). A széles univerzumon ez a kérdés dönti el,
   * hogy a kitörést vagy a legnagyobb zajt vásároljuk meg — lásd `momentum-ranking.ts`.
   */
  momentumRanking?: MomentumRanker;
  /**
   * A döntés ideje. Ha megadod, a rendszer ELLENŐRZI a legutolsó lezárt gyertya korát, és
   * az elavult sorozatú papírba nem enged ÚJ belépőt (a kilépés nem tiltott).
   */
  nowMs?: number;
  /** Az életkor-küszöb felülírása. Üresen `defaultMaxBarAgeMs(timeframe)`. */
  maxBarAgeMs?: number;
}

export interface PlanStockCycleResult {
  plan: ProfitCyclePlan;
  signals: Record<string, SymbolSignals>;
  /** A legutolsó napi záróár symbolonként (a végrehajtási referencia). */
  lastClose: Record<string, number>;
  atrBySymbol: Record<string, number>;
  /** Papírok, amiknek a legutolsó gyertyája ELAVULT — ezekbe nincs új belépő. */
  staleSymbols: string[];
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
 * Részvény-gyertyák UNIFORM rácsra vetítése a jel-számításhoz (napi ÉS intraday).
 *
 * Miért kell: a `computeSymbolSignals` a hézagot FIX ms-távolsággal méri (a kripto 1h
 * bar pontosan 3 600 000 ms-enként jön). A részvény-bar naptári távolsága viszont ugrik:
 * napi baron hétvégén 3 nap, ünnepnapon 4, DST-váltáskor ±1 óra; intraday baron pedig a
 * 16:00 ET zárás és a másnap 09:30 ET nyitás között 17,5 óra telik el. Rács nélkül a
 * részvény-sor MINDIG „réses" lenne, `sufficient: false`, és a sáv soha nem lépne be.
 *
 * A hézagot ezért a NAPTÁR dönti el, nem a nyers óra:
 *  - napi bar: egymást követő KERESKEDÉSI nap → +1 lépés,
 *  - intraday bar: ugyanazon a napon pontos időkeret-távolság → +1 lépés; ülés-határon
 *    (előző kereskedési nap utolsó bara → mai első bar) szintén +1 lépés,
 *  - minden más (VALÓDI kimaradt bar/ülés) → +2 lépés, amit a `contiguousTail` elvág.
 *
 * A szintetikus idő CSAK a jel-számításé; a végrehajtás a valódi gyertyák záróárával
 * dolgozik.
 */
export function toSignalCandles(candles: OhlcvCandle[], timeframe: Timeframe = "1d"): SignalCandle[] {
  const step = TIMEFRAME_MS[timeframe];
  const out: SignalCandle[] = [];
  let t = 0;
  let prev: { key: string; openTime: number } | null = null;
  for (const c of candles) {
    const key = etDateKey(etParts(c.openTime));
    if (prev !== null) {
      const contiguous =
        timeframe === "1d"
          ? previousTradingDayKey(key) === prev.key
          : key === prev.key
            ? c.openTime - prev.openTime === step
            : previousTradingDayKey(key) === prev.key; // ülés-határ: az éjszaka nem hézag
      t += contiguous ? step : 2 * step;
    }
    out.push({ openTime: t, high: c.high, low: c.low, close: c.close });
    prev = { key, openTime: c.openTime };
  }
  return out;
}

/**
 * A részvény döntés-terve tisztán: napi gyertyák → jelek (computeAllSignals) →
 * profit-ciklus (planProfitCycle). Pontosan ugyanaz a stratégiai gép, amit a kripto
 * kód-alapú ága használ; a különbség csak az adat (napi részvény) és a lépésköz.
 */
export function planStockCycle(input: PlanStockCycleInput): PlanStockCycleResult {
  const strategy = input.strategy ?? STOCK_STRATEGY;
  const timeframe = input.timeframe ?? "1d";
  const stepMs = TIMEFRAME_MS[timeframe];

  const signalCandles: Record<string, SignalCandle[]> = {};
  const lastClose: Record<string, number> = {};
  const changePct: { symbol: string; change24hPct: number; atrPct?: number; benchmarkChangePct?: number }[] = [];
  const latestBand: Record<string, { low: number; high: number; close: number }> = {};

  for (const [symbol, candles] of Object.entries(input.candlesBySymbol)) {
    if (candles.length === 0) continue;
    signalCandles[symbol] = toSignalCandles(candles, timeframe);
    const last = candles[candles.length - 1];
    lastClose[symbol] = last.close;
    latestBand[symbol] = { low: last.low, high: last.high, close: last.close };
    if (candles.length >= 2) {
      const prev = candles[candles.length - 2].close;
      if (prev > 0) changePct.push({ symbol, change24hPct: (last.close / prev - 1) * 100 });
    }
  }

  // ADAT-FRISSESSÉG (audit 2. pont): elavult sorozatból nincs ÚJ belépő.
  const staleSymbols =
    input.nowMs === undefined
      ? []
      : staleSymbolsAt(input.candlesBySymbol, input.nowMs, timeframe, input.maxBarAgeMs);
  const stale = new Set(staleSymbols);

  const signals = computeAllSignals(signalCandles, strategy, stepMs);
  const atrBySymbol: Record<string, number> = {};
  const trendOkBySymbol: Record<string, boolean> = {};
  const momentumOkBySymbol: Record<string, boolean> = {};
  for (const [sym, sig] of Object.entries(signals)) {
    atrBySymbol[sym] = sig.atr;
    // Az elavult sorozat MINDEN belépő-utat zár, nem csak a momentumot: a fear-DCA a
    // trend-engedélyen és a változás-listán keresztül lépne be, ezért ott is tiltjuk.
    trendOkBySymbol[sym] = stale.has(sym) ? false : sig.trendOk;
    momentumOkBySymbol[sym] = stale.has(sym)
      ? false
      : input.entryShape
      ? sig.sufficient &&
        input.entryShape({
          symbol: sym,
          candles: input.candlesBySymbol[sym] ?? [],
          candlesBySymbol: input.candlesBySymbol,
          strategy,
        })
      : sig.momentumOk;
  }

  // A rangsor bemenete. Az ATR az ÁRHOZ mérten megy tovább (különben a drágább papír
  // pusztán a nagyobb abszolút ingásától tűnne volatilisebbnek), a benchmark-változás
  // pedig a piac sodrásának levonásához kell.
  const benchChange = changePct.find((c) => c.symbol === MOMENTUM_BENCHMARK)?.change24hPct;
  for (const c of changePct) {
    const atr = atrBySymbol[c.symbol] ?? 0;
    const close = lastClose[c.symbol] ?? 0;
    if (atr > 0 && close > 0) c.atrPct = (atr / close) * 100;
    if (benchChange !== undefined) c.benchmarkChangePct = benchChange;
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
      coinChanges: changePct.filter((c) => !stale.has(c.symbol)),
      weeklyBudgetRemainingUsd: input.weeklyBudgetRemainingUsd,
      totalEquity: input.totalEquityUsd,
      atrBySymbol,
      trendOkBySymbol,
      momentumOkBySymbol,
      momentumRanker: input.momentumRanking,
    },
    strategy,
  );

  return { plan, signals, lastClose, atrBySymbol, staleSymbols };
}

// ── Végrehajtás (INJEKTÁLHATÓ) ───────────────────────────────────────────────────

export interface StockCycleAction {
  kind: "stop-loss" | "take-profit" | "dca" | "momentum" | "eod-flat";
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
  /** A gyertyák időkerete. Napi swing: "1d"; day trading: "5m". */
  timeframe?: Timeframe;
  /**
   * Az ülés fázisa (day trading). `trading` = teljes ciklus; `no-new-entries` = csak
   * kilépés; `flatten` = MINDEN pozíció zárása. Napi swing-módban hagyd üresen.
   */
  phase?: IntradayPhase;
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
  /**
   * Papírok, amikre MA nem nyitunk új pozíciót (pl. gyorsjelentés napja). A meglévő
   * pozíció kezelése (stop / take-profit / nap végi zárás) NEM tiltott — csak a belépő.
   */
  entryBlocked?: ReadonlySet<string>;
  /**
   * Köthető-e TÖRT részvény. Csak akkor igaz, ha az Alpaca MINDEN aktív papírra
   * visszaigazolta a `fractionable` jelzőt; enélkül a fill egész darabra kerekít.
   */
  fractional?: boolean;
  /** Cserélhető belépő-alak (mérés). Üresen a beépített kitörés-jel dönt. */
  entryShape?: EntryShape;
  /** Cserélhető momentum-rangsor (mérés). Üresen a nyers százalék-maximum dönt. */
  momentumRanking?: MomentumRanker;
  /**
   * NAPI VESZTESÉGKAPU (audit 1. pont). A hívó adja, mert perzisztenciát igényel: az éles
   * runner a DB-s `resolveDayGate`-et köti be ülés-napra, a backteszt ugyanazt a TISZTA
   * `evaluateDayGate`-et memóriában. Hiányában nincs kapu — ezért az éles utakon KÖTELEZŐ
   * megadni; a hiányát a runner-tesztek őrzik.
   *
   * A kapu KIZÁRÓLAG új vételt tilthat: a stop, a take-profit és a nap végi laposra zárás
   * a risk-manager SELL-ágán fut, amit a latch nem érint.
   */
  resolveDayGate?: (equityUsd: Dec | null, nowMs: number) => Promise<StockDayGateState> | StockDayGateState;
  /** Az adat-életkor küszöbének felülírása. Üresen `defaultMaxBarAgeMs(timeframe)`. */
  maxBarAgeMs?: number;
  /**
   * VÉGREHAJTÁSI ár felülírása symbolonként — CSAK mérésre (audit 2. pont).
   *
   * A jel és a fill ma ugyanabból a lezárt gyertyából dolgozik, vagyis a backteszt abban a
   * pillanatban köt, amikor a jel elkészül. Élesben a kötés ennél KÉSŐBB történik, más
   * áron. Ezzel a hurokkal a késleltetés HATÁSA mérhető (pl. a következő bar nyitóján
   * fillelve), anélkül hogy a jel megváltozna. Élesben soha nincs megadva.
   */
  executionPrices?: Record<string, Dec>;
  /**
   * Fill-költség felülírás — CSAK mérésre. Ezzel dönthető el, hogy egy variáns előnye a
   * jelből jön-e, vagy pusztán abból, hogy kevesebbet kereskedik (és így kevesebb
   * spreadet/slippage-et fizet). Élesben soha nincs megadva.
   */
  costOverride?: { slippageBps?: number; spreadBps?: number; feePct?: string };
  /** Broker felülírás (teszt). Alap: PaperExecutionBroker USD/stock-paraméterekkel. */
  broker?: ExecutionBroker;
}

export interface RunStockCycleResult {
  ledger: LedgerState;
  actions: StockCycleAction[];
  signals: Record<string, SymbolSignals>;
  plan: ProfitCyclePlan;
  lastClose: Record<string, number>;
  /**
   * `flatten` fázis után NYITVA maradt papírok (audit 3. pont). Üres tömb = a sáv
   * igazoltan lapos. Bármi más TARTÓS INCIDENS: a hívó nem jelentheti sikeres zárásnak,
   * mert éjszakai kitettség maradt — tipikusan hiányzó gyertya vagy elutasított fill miatt.
   */
  unflattened: string[];
  /** Papírok elavult gyertyasorral — ezekbe a ciklus nem nyitott új pozíciót. */
  staleSymbols: string[];
}

/**
 * A részvény profit-ciklus végrehajtása a KÖZÖS úton (risk-manager + executeIntent +
 * PaperExecutionBroker), USD-scope-ban. Perzisztencia nélkül memóriában fut.
 */
export async function runStockCycle(deps: RunStockCycleDeps): Promise<RunStockCycleResult> {
  const now = deps.now;
  const strategy = deps.strategy ?? STOCK_STRATEGY;
  const strategyVersion = deps.strategyVersion ?? STOCK_STRATEGY_VERSION;
  const positionIdBySymbol = deps.positionIdBySymbol ?? {};
  let ledger = deps.ledger;
  let weeklyRemaining = dec(deps.weeklyBudgetRemainingUsd ?? 0);

  const allowedSymbols = deps.instruments.map((i) => i.symbol);

  // ELAVULT ADAT = NINCS ÁR. Egy öt napja lezárt gyertya nem bizonyítja, hogy az ár most is
  // érvényes, ezért nemcsak a belépő tiltott: ebből az árból KÖTÉST SEM gyártunk — sem
  // stopot, sem nap végi zárást. Kitalált fill-ár helyett a pozíció nyitva marad, és az
  // `unflattened`/`staleSymbols` mezőben megnevezve, incidensként látszik. Az equity is
  // emiatt válik nem mérhetővé, ami a napi kaput is fail-closed állapotba viszi.
  const staleForExecution = new Set(
    staleSymbolsAt(deps.candlesBySymbol, now(), deps.timeframe ?? "1d", deps.maxBarAgeMs),
  );
  const pricesDec: Record<string, Dec> = {};
  for (const [symbol, candles] of Object.entries(deps.candlesBySymbol)) {
    if (candles.length > 0 && !staleForExecution.has(symbol)) {
      pricesDec[symbol] = dec(candles[candles.length - 1].close);
    }
  }

  // A napi close a végrehajtási ár (a backteszt konvenciója). A broker ezt kapja `last`-ként.
  // A `executionPrices` felülírás CSAK a fill árát mozdítja — a jel, a stop/TP kiértékelés
  // és az equity a lezárt gyertyából marad.
  const market = (symbol: string) => {
    const px = deps.executionPrices?.[symbol] ?? pricesDec[symbol];
    return px ? { last: px } : null;
  };

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
        ...(deps.costOverride ?? {}),
        filters: stockSymbolFilters("STOCK", STOCK_QUOTE, now(), { fractional: deps.fractional === true }),
        nowMs: now(),
      },
      // A ZÁRÁS nem a belépő metaadat-kapuján megy (audit 3. pont): egy meglévő pozíciót
      // a tényleges készlet szerint kell tudni zárni, különben tört maradvány ragad bent.
      paramsFor: (intent) => ({
        ...fillParamsForClass("stock"),
        ...(deps.costOverride ?? {}),
        filters:
          intent.order.side === "SELL"
            ? stockClosingFilters("STOCK", STOCK_QUOTE, now())
            : stockSymbolFilters("STOCK", STOCK_QUOTE, now(), { fractional: deps.fractional === true }),
        nowMs: now(),
      }),
    });

  const equityUsd = (): Dec => {
    let total = ledger.cash[STOCK_QUOTE] ?? ZERO;
    for (const p of Object.values(ledger.positions)) {
      const px = pricesDec[p.symbol];
      if (px) total = add(total, mul(p.qty, px));
    }
    return total;
  };

  // A kaput a döntés ELŐTT oldjuk fel, a ciklus előtti equityvel — a saját kötéseink
  // ne mozdítsák el a napi referenciát menet közben.
  //
  // Ha egy BIRTOKOLT papírra nincs ár, az equity NEM MÉRHETŐ: ilyenkor `null` megy tovább,
  // nem egy hiányos összeg. Enélkül a hiányzó ár úgy látszana, mintha a pozíció nullát
  // érne — hamis napi veszteséget latch-elve, vagy egy hamis napkezdő referenciát rögzítve.
  const unpricedHeld = Object.values(ledger.positions).some(
    (p) => isPositive(p.qty) && pricesDec[p.symbol] === undefined,
  );
  const measurableEquity = unpricedHeld ? null : equityUsd();
  const dayGate: StockDayGateState = deps.resolveDayGate
    ? await deps.resolveDayGate(measurableEquity, now())
    : { latched: false, baselineMissing: false };

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
      dailyLossLatched: dayGate.latched,
      dayBaselineMissing: dayGate.baselineMissing,
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
    timeframe: deps.timeframe,
    entryShape: deps.entryShape,
    momentumRanking: deps.momentumRanking,
    nowMs: now(),
    maxBarAgeMs: deps.maxBarAgeMs,
  });

  // Trailing ratchet: a stop CSAK felfelé kúszik.
  for (const u of planned.plan.stopUpdates) {
    const symbol = positions.find((p) => p.id === u.positionId)?.symbol;
    if (!symbol) continue;
    ledger = setStop(ledger, symbol, dec(u.newStop));
    if (deps.persistStop) await deps.persistStop(symbol, dec(u.newStop));
  }

  const actions: StockCycleAction[] = [];
  const phase = deps.phase ?? "trading";

  // A SELL-ek előbb (a felszabaduló cash a belépőnek hasznosul). Belépő CSAK `trading`
  // fázisban van: zárás előtt (`no-new-entries`, `flatten`) már nem nyitunk újat.
  const blocked = deps.entryBlocked;
  const ordered = [
    ...planned.plan.orders.filter((o) => o.side === "SELL"),
    ...(phase === "trading"
      ? planned.plan.orders.filter((o) => o.side === "BUY" && !(blocked?.has(o.symbol) ?? false))
      : []),
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

  // NAP VÉGI LAPOSRA ZÁRÁS (day trading): ami a stop/TP után is nyitva maradt, megy.
  // Ez a day trading lényege — a pozíció nem viheti át az éjszakai gap-kockázatot.
  if (phase === "flatten") {
    for (const p of Object.values(ledger.positions)) {
      if (!isPositive(p.qty)) continue;
      const px = pricesDec[p.symbol];
      if (!px) continue;
      const fill = await runIntent({
        side: "SELL",
        symbol: p.symbol,
        baseQty: p.qty,
        origin: "eod-flat",
        referencePrice: px,
      });
      if (!fill) continue;
      actions.push({
        kind: "eod-flat",
        side: "SELL",
        symbol: p.symbol,
        amountUsd: toNumber(fill.grossQuoteAmount),
        qty: toNumber(fill.filledBaseQty),
      });
    }
  }

  // A zárás UTÁNI tényleges maradék — nem a szándékot, hanem az eredményt nézzük.
  const unflattened =
    phase === "flatten"
      ? Object.values(ledger.positions)
          .filter((p) => isPositive(p.qty))
          .map((p) => p.symbol)
          .sort()
      : [];

  return {
    ledger,
    actions,
    signals: planned.signals,
    plan: planned.plan,
    lastClose: planned.lastClose,
    unflattened,
    staleSymbols: planned.staleSymbols,
  };
}

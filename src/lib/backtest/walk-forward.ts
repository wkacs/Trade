import type { HistoryFrame, BacktestResult } from "./types";

/**
 * Időben gördülő tanítás/validálás és ZÁROLT végső teszt (T19).
 *
 * Az audit §7 kifogása: a tournament 3024 konfiguráció közül úgy választott, hogy a
 * TESZTSZAKASZ teljesítményét is nézte. Ezzel a szakasz validációs adattá vált, nem
 * független végső teszt maradt — és a „robust" mód sem adta vissza a függetlenségét.
 *
 * Itt a szabály szigorú:
 *  1. A történet ELEJE a FEJLESZTÉSI rész (tanítás + validálás), a VÉGE a ZÁROLT holdout.
 *  2. A jelölt kiválasztása KIZÁRÓLAG a fejlesztési részből történhet.
 *  3. A holdouton EGYSZER mérünk, és utána már nem rangsorolunk.
 *
 * A warmup mindig a MÚLTBÓL jön: minden szelet a saját előzményével kezdődik.
 */

/** Idő szerinti split: első `ratio` rész = in-sample, a maradék = out-of-sample. */
export function splitHistory(
  frames: HistoryFrame[],
  ratio = 0.7,
): { inSample: HistoryFrame[]; outSample: HistoryFrame[] } {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(sorted.length * ratio);
  return { inSample: sorted.slice(0, cut), outSample: sorted.slice(cut) };
}

export interface HoldoutSplit {
  /** Amin szabad válogatni (tanítás + validálás). */
  development: HistoryFrame[];
  /** ZÁROLT végső teszt. A jelöltválasztás NEM láthatja. */
  holdout: HistoryFrame[];
}

/** A történet végének zárolása. A holdout SOHA nem megy a kiválasztásba. */
export function lockHoldout(frames: HistoryFrame[], holdoutRatio = 0.2): HoldoutSplit {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const cut = Math.max(0, Math.floor(sorted.length * (1 - holdoutRatio)));
  return { development: sorted.slice(0, cut), holdout: sorted.slice(cut) };
}

export interface RollingSplit {
  index: number;
  train: HistoryFrame[];
  validation: HistoryFrame[];
}

export interface RollingOptions {
  trainBars: number;
  validationBars: number;
  /** Mennyivel lép előre két szelet között. Alapértelmezés: a validációs ablak hossza. */
  stepBars?: number;
  /**
   * A validációs szelet elé fűzött ELŐZMÉNY (warmup). A stratégia visszatekintése ennyi
   * gyertyát igényel; a warmup a MÚLTBÓL jön, sosem a jövőből.
   */
  warmupBars?: number;
}

/**
 * Időben gördülő tanítás/validálás szeletek. Minden validációs szelet SZIGORÚAN a saját
 * tanító szelete UTÁN következik, és a warmup a megelőző adatból jön.
 */
export function rollingSplits(frames: HistoryFrame[], options: RollingOptions): RollingSplit[] {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const step = options.stepBars ?? options.validationBars;
  const warmup = options.warmupBars ?? 0;
  const out: RollingSplit[] = [];
  let index = 0;
  for (let start = 0; start + options.trainBars + options.validationBars <= sorted.length; start += step) {
    const trainEnd = start + options.trainBars;
    const valEnd = trainEnd + options.validationBars;
    out.push({
      index: index++,
      train: sorted.slice(start, trainEnd),
      // A warmup a validációs ablak ELŐTTI adatból jön — nincs jövőbeli információ.
      validation: sorted.slice(Math.max(0, trainEnd - warmup), valEnd),
    });
  }
  return out;
}

export interface RankedConfig<C> {
  config: C;
  is: BacktestResult;
  oos: BacktestResult;
}

/**
 * Rangsorol a configok között; min-trade kapu az OOS-on.
 * - alapból: OOS Sharpe szerint (csökkenő), holtverseny → OOS return.
 * - robust módban: csak IS>0 ÉS OOS>0 Sharpe, rangsor a gyengébbik (min) Sharpe szerint.
 *
 * FONTOS: az „OOS" itt a FEJLESZTÉSI részen belüli validáció, NEM a zárolt holdout.
 */
export function rankConfigs<C>(
  items: RankedConfig<C>[],
  minTrades: number,
  opts: { robust?: boolean } = {},
): RankedConfig<C>[] {
  const gated = items.filter((x) => x.oos.metrics.tradesCount >= minTrades);
  if (!opts.robust) {
    return gated.sort(
      (a, b) =>
        b.oos.metrics.sharpe - a.oos.metrics.sharpe ||
        b.oos.metrics.totalReturnPct - a.oos.metrics.totalReturnPct,
    );
  }
  const robustScore = (r: RankedConfig<C>) => Math.min(r.is.metrics.sharpe, r.oos.metrics.sharpe);
  return gated
    .filter((x) => x.is.metrics.sharpe > 0 && x.oos.metrics.sharpe > 0)
    .sort(
      (a, b) =>
        robustScore(b) - robustScore(a) ||
        b.oos.metrics.totalReturnPct - a.oos.metrics.totalReturnPct,
    );
}

export interface CandidateScore<C> {
  config: C;
  /** Szeletenkénti validációs Sharpe. */
  validationSharpes: number[];
  /** A gyengébbik szeletek szerinti robusztus pontszám (a legkisebb validációs Sharpe). */
  robustScore: number;
  meanValidationSharpe: number;
  totalTrades: number;
}

export interface Selection<C> {
  /** A KIVÁLASZTOTT jelölt — kizárólag a fejlesztési részből. */
  winner: CandidateScore<C> | null;
  /** Minden jelölt pontszáma (a sikertelenek is megmaradnak). */
  ranked: CandidateScore<C>[];
  /** Hány szeleten mértünk. */
  splits: number;
  /** A kiválasztáshoz használt adat hash-e — a holdouté KÜLÖN. */
  developmentDataHash: string;
}

/**
 * Jelöltválasztás a FEJLESZTÉSI részből. A holdout adat ide EL SEM JUT: a függvény csak
 * a `splits`-et kapja, ami a `lockHoldout().development`-ből származik.
 *
 * Rangsor: a szeletek LEGGYENGÉBB validációs Sharpe-ja (a szerencsés egyszeri találat
 * így nem nyer), holtversenyben az átlag.
 */
export function selectCandidate<C>(
  candidates: C[],
  splits: RollingSplit[],
  evaluate: (config: C, split: RollingSplit) => BacktestResult,
  options: { minTradesPerSplit?: number; developmentDataHash?: string } = {},
): Selection<C> {
  const minTrades = options.minTradesPerSplit ?? 0;
  const ranked: CandidateScore<C>[] = candidates.map((config) => {
    const results = splits.map((s) => evaluate(config, s));
    const sharpes = results.map((r) => r.metrics.sharpe);
    const totalTrades = results.reduce((s, r) => s + r.metrics.tradesCount, 0);
    return {
      config,
      validationSharpes: sharpes,
      robustScore: sharpes.length > 0 ? Math.min(...sharpes) : Number.NEGATIVE_INFINITY,
      meanValidationSharpe: sharpes.length > 0 ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : 0,
      totalTrades,
    };
  });

  const eligible = ranked
    .filter((c) => c.totalTrades >= minTrades * Math.max(1, splits.length))
    .sort((a, b) => b.robustScore - a.robustScore || b.meanValidationSharpe - a.meanValidationSharpe);

  return {
    winner: eligible[0] ?? null,
    ranked: [...ranked].sort((a, b) => b.robustScore - a.robustScore),
    splits: splits.length,
    developmentDataHash: options.developmentDataHash ?? "",
  };
}

export interface HoldoutReport<C> {
  config: C;
  metrics: BacktestResult["metrics"];
  holdoutDataHash: string;
  /** Igaz — emlékeztető, hogy a holdouton MÁR NEM rangsorolunk. */
  singleEvaluation: true;
  bars: number;
}

/**
 * A kiválasztott jelölt EGYSZERI mérése a zárolt holdouton. Nincs visszacsatolás:
 * a függvény nem kap jelöltlistát, tehát nem is tud rangsorolni.
 */
export function evaluateOnHoldout<C>(
  winner: C,
  holdout: HistoryFrame[],
  evaluate: (config: C, frames: HistoryFrame[]) => BacktestResult,
): HoldoutReport<C> {
  const result = evaluate(winner, holdout);
  return {
    config: winner,
    metrics: result.metrics,
    holdoutDataHash: dataHash(holdout),
    singleEvaluation: true,
    bars: holdout.length,
  };
}

/**
 * Determinisztikus adat-hash (FNV-1a). Ugyanaz az adat → ugyanaz a hash → a riport
 * reprodukálhatósága ellenőrizhető. Nem kriptográfiai célra.
 */
export function dataHash(frames: HistoryFrame[]): string {
  let h = 0x811c9dc5;
  const bump = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const f of [...frames].sort((a, b) => a.ts - b.ts)) {
    bump(String(f.ts));
    bump(String(f.fearGreedValue ?? "n"));
    for (const sym of Object.keys(f.candles).sort()) {
      const c = f.candles[sym];
      bump(`${sym}|${c.open}|${c.high}|${c.low}|${c.close}|${c.volume}`);
    }
  }
  return h.toString(16).padStart(8, "0");
}

/** A riport reprodukálhatósági fejléce — minden mérés mellé ez kerül. */
export interface RunProvenance {
  developmentDataHash: string;
  holdoutDataHash: string;
  strategyVersion: string;
  /** A költségfeltevés, ami mellett a szám született. */
  feePct: number;
  slippageBps: number;
  initialCapitalUsd: number;
  executionModel: string;
  bars: { development: number; holdout: number };
}

export function buildProvenance(
  split: HoldoutSplit,
  config: { feePct: number; slippageBps: number; initialCapitalUsd: number; executionModel?: string },
  strategyVersion: string,
): RunProvenance {
  return {
    developmentDataHash: dataHash(split.development),
    holdoutDataHash: dataHash(split.holdout),
    strategyVersion,
    feePct: config.feePct,
    slippageBps: config.slippageBps,
    initialCapitalUsd: config.initialCapitalUsd,
    executionModel: config.executionModel ?? "polling",
    bars: { development: split.development.length, holdout: split.holdout.length },
  };
}

import type { HistoryFrame, BacktestConfig, BacktestMetrics, EquityPoint } from "./types";
import { runBacktest } from "./engine";
import { computeMetrics } from "./metrics";
import { DEFAULT_STRATEGY, type StrategyConfig } from "@/lib/strategy/config";

/**
 * Alapvonalak (T19). Egy stratégia csak akkor ér valamit, ha VER egy triviális
 * alternatívát AZONOS időszakon, AZONOS tőkével és AZONOS költségfeltevéssel.
 *
 * Kötelező referenciák:
 *  - `cash`: nem csinálunk semmit (0% hozam, 0 kockázat) — a valódi alsó korlát;
 *  - `buy-and-hold`: egyszer veszünk, végig tartunk (egy vételi díj + csúszás);
 *  - a javított DCA alapvonal (a mai default stratégia).
 */

export interface BenchmarkResult {
  name: string;
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  /** Amit a szám mellett tudni KELL, hogy értelmezhető legyen. */
  notes: string[];
}

const HOUR = 3600_000;

/** Készpénz-alapvonal: az equity végig a kezdőtőke. */
export function cashBenchmark(frames: HistoryFrame[], initialCapitalUsd: number): BenchmarkResult {
  const equityCurve = frames.map((f) => ({ ts: f.ts, equityUsd: initialCapitalUsd }));
  const samplingHours = frames.length > 1 ? Math.max(1, Math.round((frames[1].ts - frames[0].ts) / HOUR)) : 1;
  return {
    name: "cash",
    metrics: computeMetrics(equityCurve, [], 0, { samplingHours, buyFeesUsd: 0 }),
    equityCurve,
    notes: ["Nincs kötés, nincs díj, nincs kitettség. Ez az alsó korlát, amit meg KELL verni."],
  };
}

/**
 * Buy-and-hold: az ELSŐ elérhető gyertya NYITÓJÁN veszünk (nincs look-ahead), egy
 * vételi díjjal és csúszással, majd végig tartunk.
 */
export function buyAndHoldBenchmark(
  frames: HistoryFrame[],
  symbol: string,
  config: BacktestConfig,
): BenchmarkResult {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const first = sorted.find((f) => f.candles[symbol]);
  if (!first) {
    return {
      name: `buy-and-hold:${symbol}`,
      metrics: computeMetrics([], [], 0),
      equityCurve: [],
      notes: [`Nincs ${symbol} adat ebben az időszakban — nem eldönthető.`],
    };
  }
  const slip = config.slippageBps / 10000;
  const entryPrice = first.candles[symbol]!.open * (1 + slip);
  const gross = config.initialCapitalUsd / (1 + config.feePct);
  const feeUsd = gross * config.feePct;
  const qty = gross / entryPrice;

  const equityCurve: EquityPoint[] = sorted.map((f) => {
    const px = f.candles[symbol]?.close;
    return { ts: f.ts, equityUsd: px ? qty * px : config.initialCapitalUsd };
  });
  const samplingHours = sorted.length > 1 ? Math.max(1, Math.round((sorted[1].ts - sorted[0].ts) / HOUR)) : 1;

  return {
    name: `buy-and-hold:${symbol}`,
    metrics: computeMetrics(equityCurve, [], sorted.length, { samplingHours, buyFeesUsd: feeUsd }),
    equityCurve,
    notes: [
      `Belépés az első gyertya NYITÓJÁN (${entryPrice.toFixed(2)}), egy vételi díjjal (${feeUsd.toFixed(4)} USD).`,
      "Végig 100% kitettség — a drawdown ezért nem hasonlítható közvetlenül egy alacsony kitettségű stratégiáéhoz.",
    ],
  };
}

export interface BenchmarkSuiteOptions {
  /** A mérendő tőkeszintek. A 100 USD KÖTELEZŐ: a minimum-order ott válik korláttá. */
  capitals?: number[];
  /** Költség-stressz szorzók (1 = alap, 2 = kétszeres díj és csúszás). */
  costMultipliers?: number[];
  strategies?: { name: string; config: StrategyConfig }[];
  symbols?: string[];
}

export interface SuiteEntry {
  capitalUsd: number;
  costMultiplier: number;
  name: string;
  metrics: BacktestMetrics;
  notes: string[];
}

/**
 * A teljes összehasonlító készlet: minden tőkeszinten és költségszinten ugyanazok a
 * referenciák és stratégiák. A sikertelen változatok is BENNE MARADNAK.
 */
export function benchmarkSuite(
  frames: HistoryFrame[],
  base: BacktestConfig,
  options: BenchmarkSuiteOptions = {},
): SuiteEntry[] {
  const capitals = options.capitals ?? [100, 10000];
  const multipliers = options.costMultipliers ?? [1, 2];
  const strategies = options.strategies ?? [{ name: "dca-baseline", config: DEFAULT_STRATEGY }];
  const symbols = options.symbols ?? base.symbols;
  const out: SuiteEntry[] = [];

  for (const capitalUsd of capitals) {
    for (const costMultiplier of multipliers) {
      const config: BacktestConfig = {
        ...base,
        initialCapitalUsd: capitalUsd,
        feePct: base.feePct * costMultiplier,
        slippageBps: base.slippageBps * costMultiplier,
      };

      const cash = cashBenchmark(frames, capitalUsd);
      out.push({ capitalUsd, costMultiplier, name: cash.name, metrics: cash.metrics, notes: cash.notes });

      for (const symbol of symbols) {
        const bh = buyAndHoldBenchmark(frames, symbol, config);
        out.push({ capitalUsd, costMultiplier, name: bh.name, metrics: bh.metrics, notes: bh.notes });
      }

      for (const s of strategies) {
        const r = runBacktest(frames, config, s.config);
        const notes: string[] = [];
        const belowMin = r.rejections.below_min_notional ?? 0;
        if (belowMin > 0) {
          notes.push(
            `${belowMin} order esett a minimum kötésérték alá — ${capitalUsd} USD tőkén ez valódi korlát, nem mérési zaj.`,
          );
        }
        if (r.metrics.tradesCount === 0) {
          notes.push("Nem született lezárt kötés — az eredmény NEM ELDÖNTHETŐ, nem nulla hozam.");
        }
        out.push({ capitalUsd, costMultiplier, name: s.name, metrics: r.metrics, notes });
      }
    }
  }
  return out;
}

/** Egy stratégia verte-e a referenciát ugyanazon a soron? Tiszta összehasonlítás. */
export function beatsBenchmark(entries: SuiteEntry[], strategyName: string, benchmarkName: string): boolean | null {
  const s = entries.find((e) => e.name === strategyName);
  const b = entries.find((e) => e.name === benchmarkName);
  if (!s || !b) return null;
  if (s.metrics.tradesCount === 0) return null; // nem eldönthető
  return s.metrics.totalReturnPct > b.metrics.totalReturnPct;
}

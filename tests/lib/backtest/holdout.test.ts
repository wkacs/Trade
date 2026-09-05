import { describe, it, expect } from "vitest";
import {
  lockHoldout,
  rollingSplits,
  selectCandidate,
  evaluateOnHoldout,
  dataHash,
  buildProvenance,
} from "@/lib/backtest/walk-forward";
import { cashBenchmark, buyAndHoldBenchmark, benchmarkSuite, beatsBenchmark } from "@/lib/backtest/benchmarks";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import type { HistoryFrame, BacktestConfig, BacktestResult } from "@/lib/backtest/types";

const H = 3600_000;

const bar = (i: number, close: number): HistoryFrame => ({
  ts: i * H,
  candles: { BTC: { ts: i * H, open: close, high: close, low: close, close, volume: 1 } },
  fearGreedValue: 50,
});

/** Minimális BacktestResult a determinisztikus kiválasztás-teszthez. */
const res = (sharpe: number, trades: number, ret = 0): BacktestResult => ({
  metrics: {
    totalReturnPct: ret,
    sharpe,
    maxDrawdownPct: 0,
    hitRate: 0,
    tradesCount: trades,
    avgWinPct: 0,
    avgLossPct: 0,
    profitFactor: 0,
    profitFactorInfinite: false,
    exposurePct: 0,
    totalFeesUsd: 0,
    samplingHours: 1,
  },
  equityCurve: [],
  closedTrades: [],
  realizations: [],
  entries: [],
  rejections: {},
  config: { symbols: [], initialCapitalUsd: 0, feePct: 0, slippageBps: 0 },
  from: 0,
  to: 0,
});

describe("lockHoldout — a végső teszt ZÁROLT (T19)", () => {
  const frames = Array.from({ length: 100 }, (_, i) => bar(i, 100 + i));

  it("a holdout a történet VÉGE, és nem fedi át a fejlesztési részt", () => {
    const { development, holdout } = lockHoldout(frames, 0.2);
    expect(development).toHaveLength(80);
    expect(holdout).toHaveLength(20);
    expect(Math.max(...development.map((f) => f.ts))).toBeLessThan(Math.min(...holdout.map((f) => f.ts)));
  });

  it("a fejlesztési és a holdout adat hash-e KÜLÖNBÖZIK", () => {
    const { development, holdout } = lockHoldout(frames, 0.2);
    expect(dataHash(development)).not.toBe(dataHash(holdout));
  });
});

describe("rollingSplits — a warmup a MÚLTBÓL jön", () => {
  const frames = Array.from({ length: 100 }, (_, i) => bar(i, 100 + i));

  it("minden validációs szelet a saját tanító szelete UTÁN kezdődik", () => {
    const splits = rollingSplits(frames, { trainBars: 30, validationBars: 10 });
    expect(splits.length).toBeGreaterThan(1);
    for (const s of splits) {
      const trainEnd = Math.max(...s.train.map((f) => f.ts));
      const valEnd = Math.max(...s.validation.map((f) => f.ts));
      expect(valEnd).toBeGreaterThan(trainEnd);
    }
  });

  it("a warmup a validáció ELŐTTI adatból jön, nem a jövőből", () => {
    const [s] = rollingSplits(frames, { trainBars: 30, validationBars: 10, warmupBars: 5 });
    expect(s.validation).toHaveLength(15);
    expect(s.validation[0].ts).toBe(25 * H);
  });

  it("nincs elég adat → nincs szelet (nem találunk ki keretet)", () => {
    expect(rollingSplits(frames.slice(0, 20), { trainBars: 30, validationBars: 10 })).toEqual([]);
  });
});

describe("selectCandidate — a holdout NEM befolyásolhatja a választást", () => {
  const frames = Array.from({ length: 100 }, (_, i) => bar(i, 100 + i));
  const { development, holdout } = lockHoldout(frames, 0.2);
  const splits = rollingSplits(development, { trainBars: 30, validationBars: 10 });

  /** A validációs Sharpe determinisztikusan a config quality mezőjéből jön. */
  const evaluate = (config: { name: string; quality: number }, split: { index: number }) =>
    res(config.quality + split.index * 0.01, 10);

  it("a leggyengébb szelet szerint rangsorol (a szerencsés találat nem nyer)", () => {
    const candidates = [
      { name: "stabil", quality: 1.0 },
      { name: "szerencses", quality: 0.2 },
    ];
    const sel = selectCandidate(candidates, splits, evaluate);
    expect(sel.winner?.config.name).toBe("stabil");
    expect(sel.ranked).toHaveLength(2);
  });

  it("a sikertelen jelöltek is MEGMARADNAK a jelentésben", () => {
    const sel = selectCandidate(
      [
        { name: "a", quality: 1 },
        { name: "b", quality: -5 },
      ],
      splits,
      evaluate,
    );
    expect(sel.ranked.map((r) => r.config.name).sort()).toEqual(["a", "b"]);
  });

  it("a MÓDOSÍTOTT holdout-eredmény NEM változtatja a már kiválasztott jelöltet", () => {
    const candidates = [
      { name: "a", quality: 1 },
      { name: "b", quality: 0.5 },
    ];
    const first = selectCandidate(candidates, splits, evaluate);

    // A holdouton bármi történhet: a kiválasztás ugyanaz marad, mert a holdout adat
    // el sem jut a selectCandidate-hez.
    const holdoutReport = evaluateOnHoldout(first.winner!.config, holdout, () => res(-99, 0));
    expect(holdoutReport.metrics.sharpe).toBe(-99);

    const second = selectCandidate(candidates, splits, evaluate);
    expect(second.winner?.config.name).toBe(first.winner?.config.name);
  });

  it("a holdout-mérés EGYSZERI és jelzi is magát", () => {
    const report = evaluateOnHoldout({ name: "a", quality: 1 }, holdout, () => res(0.5, 3));
    expect(report.singleEvaluation).toBe(true);
    expect(report.bars).toBe(holdout.length);
    expect(report.holdoutDataHash).toBe(dataHash(holdout));
  });
});

describe("dataHash — reprodukálhatóság", () => {
  it("ugyanaz az adat ugyanazt a hash-t adja", () => {
    const a = Array.from({ length: 10 }, (_, i) => bar(i, 100 + i));
    const b = Array.from({ length: 10 }, (_, i) => bar(i, 100 + i));
    expect(dataHash(a)).toBe(dataHash(b));
  });

  it("egyetlen ár megváltozása MÁS hash-t ad", () => {
    const a = Array.from({ length: 10 }, (_, i) => bar(i, 100 + i));
    const b = Array.from({ length: 10 }, (_, i) => bar(i, i === 5 ? 999 : 100 + i));
    expect(dataHash(a)).not.toBe(dataHash(b));
  });

  it("a sorrend nem számít (időrendre normalizál)", () => {
    const a = Array.from({ length: 10 }, (_, i) => bar(i, 100 + i));
    expect(dataHash([...a].reverse())).toBe(dataHash(a));
  });

  it("a provenance minden reprodukcióhoz szükséges adatot tartalmaz", () => {
    const frames = Array.from({ length: 50 }, (_, i) => bar(i, 100 + i));
    const p = buildProvenance(
      lockHoldout(frames, 0.2),
      { feePct: 0.001, slippageBps: 5, initialCapitalUsd: 100 },
      "v2-test",
    );
    expect(p.strategyVersion).toBe("v2-test");
    expect(p.feePct).toBe(0.001);
    expect(p.initialCapitalUsd).toBe(100);
    expect(p.bars).toEqual({ development: 40, holdout: 10 });
    expect(p.developmentDataHash).not.toBe(p.holdoutDataHash);
  });
});

describe("benchmarks — amit meg KELL verni", () => {
  const rising = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i));
  const cfg: BacktestConfig = { symbols: ["BTC"], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 };

  it("a cash-alapvonal nulla hozam és nulla kitettség", () => {
    const b = cashBenchmark(rising, 10000);
    expect(b.metrics.totalReturnPct).toBe(0);
    expect(b.metrics.exposurePct).toBe(0);
    expect(b.metrics.totalFeesUsd).toBe(0);
  });

  it("a buy-and-hold az ELSŐ NYITÓN lép be, egy díjjal", () => {
    const b = buyAndHoldBenchmark(rising, "BTC", cfg);
    expect(b.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(b.metrics.totalFeesUsd).toBeGreaterThan(0);
    expect(b.notes.join(" ")).toMatch(/NYITÓJÁN/);
  });

  it("hiányzó adatnál a buy-and-hold NEM ELDÖNTHETŐ, nem nulla", () => {
    const b = buyAndHoldBenchmark(rising, "DOGE", cfg);
    expect(b.equityCurve).toEqual([]);
    expect(b.notes.join(" ")).toMatch(/nem eldönthető/i);
  });

  it("a készlet minden tőkeszinten és költségszinten lefut", () => {
    const entries = benchmarkSuite(rising, cfg, {
      capitals: [100, 10000],
      costMultipliers: [1, 2],
      strategies: [{ name: "dca-baseline", config: DEFAULT_STRATEGY }],
    });
    expect(new Set(entries.map((e) => e.capitalUsd))).toEqual(new Set([100, 10000]));
    expect(new Set(entries.map((e) => e.costMultiplier))).toEqual(new Set([1, 2]));
    expect(entries.some((e) => e.name === "cash")).toBe(true);
    expect(entries.some((e) => e.name === "buy-and-hold:BTC")).toBe(true);
    expect(entries.some((e) => e.name === "dca-baseline")).toBe(true);
  });

  it("kötés nélküli stratégia NEM ELDÖNTHETŐ, nem vereség", () => {
    const entries = benchmarkSuite(rising, cfg, {
      capitals: [10000],
      costMultipliers: [1],
      strategies: [{ name: "dca-baseline", config: DEFAULT_STRATEGY }],
    });
    const strat = entries.find((e) => e.name === "dca-baseline")!;
    if (strat.metrics.tradesCount === 0) {
      expect(strat.notes.join(" ")).toMatch(/NEM ELDÖNTHETŐ/);
      expect(beatsBenchmark(entries, "dca-baseline", "cash")).toBeNull();
    }
  });

  it("a 100 USD tőke minimum-order korlátja LÁTSZIK a jegyzetben", () => {
    const entries = benchmarkSuite(rising, { ...cfg, minOrderQuote: 50 }, {
      capitals: [100],
      costMultipliers: [1],
      strategies: [{ name: "dca-baseline", config: { ...DEFAULT_STRATEGY, dcaFgThreshold: 100 } }],
    });
    const strat = entries.find((e) => e.name === "dca-baseline")!;
    expect(strat.notes.length).toBeGreaterThan(0);
  });
});

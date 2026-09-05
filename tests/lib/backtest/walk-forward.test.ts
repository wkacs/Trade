import { describe, it, expect } from "vitest";
import { splitHistory, rankConfigs } from "@/lib/backtest/walk-forward";
import type { HistoryFrame, BacktestResult } from "@/lib/backtest/types";

const frame = (ts: number): HistoryFrame => ({ ts, candles: {}, fearGreedValue: null });
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

describe("walk-forward", () => {
  it("splitHistory 70/30 arányban, idő szerint", () => {
    const frames = Array.from({ length: 10 }, (_, i) => frame(i));
    const { inSample, outSample } = splitHistory(frames, 0.7);
    expect(inSample).toHaveLength(7);
    expect(outSample).toHaveLength(3);
    expect(outSample[0].ts).toBe(7);
  });

  it("rankConfigs az OOS Sharpe szerint, min-trade szűrővel", () => {
    const items = [
      { config: "A", is: res(5, 50), oos: res(0.2, 30) },
      { config: "B", is: res(1, 50), oos: res(0.9, 30) }, // jobb OOS
      { config: "C", is: res(9, 50), oos: res(2.0, 5) }, // kevés OOS trade → kiesik
    ];
    const ranked = rankConfigs(items, 15);
    expect(ranked.map((r) => r.config)).toEqual(["B", "A"]);
  });

  it("rankConfigs robust módban kizárja a negatív-IS configot és min(IS,OOS) szerint rangsorol", () => {
    const items = [
      { config: "lucky", is: res(-0.7, 30), oos: res(3.2, 30) }, // negatív IS → overfit-gyanú → kiesik
      { config: "solid", is: res(1.0, 30), oos: res(2.3, 30) }, // min(IS,OOS) = 1.0
      { config: "robust", is: res(1.8, 30), oos: res(1.5, 30) }, // min(IS,OOS) = 1.5 → első
    ];
    const ranked = rankConfigs(items, 15, { robust: true });
    expect(ranked.map((r) => r.config)).toEqual(["robust", "solid"]);
  });
});

import { describe, it, expect } from "vitest";
import { computeMetrics } from "@/lib/backtest/metrics";
import type { EquityPoint, ClosedTradePnl } from "@/lib/backtest/types";

const eq = (vals: number[]): EquityPoint[] =>
  vals.map((v, i) => ({ ts: i * 3600_000, equityUsd: v }));

describe("computeMetrics", () => {
  it("total return a kezdő és vég equity arányából", () => {
    const m = computeMetrics(eq([100, 110]), [], 1);
    expect(m.totalReturnPct).toBeCloseTo(0.1, 6);
  });

  it("max drawdown a legnagyobb csúcs→völgy esés", () => {
    const m = computeMetrics(eq([100, 120, 90, 130]), [], 4);
    // csúcs 120 → völgy 90 → dd = 30/120 = 0.25
    expect(m.maxDrawdownPct).toBeCloseTo(0.25, 6);
  });

  it("hit rate + profit factor a lezárt trade-ekből", () => {
    const trades: ClosedTradePnl[] = [
      { symbol: "BTC", entryPrice: 100, exitPrice: 110, qty: 1, pnlUsd: 10, pnlPct: 0.1 },
      { symbol: "ETH", entryPrice: 100, exitPrice: 95, qty: 1, pnlUsd: -5, pnlPct: -0.05 },
    ];
    const m = computeMetrics(eq([100, 105]), trades, 2);
    expect(m.hitRate).toBeCloseTo(0.5, 6);
    expect(m.tradesCount).toBe(2);
    expect(m.profitFactor).toBeCloseTo(2, 6); // 10 / 5
    expect(m.avgWinPct).toBeCloseTo(0.1, 6);
    expect(m.avgLossPct).toBeCloseTo(-0.05, 6);
  });

  it("üres equity → nulla metrikák, nem dob", () => {
    const m = computeMetrics([], [], 0);
    expect(m.totalReturnPct).toBe(0);
    expect(m.sharpe).toBe(0);
  });

  it("exposure a piacban töltött órák aránya", () => {
    const m = computeMetrics(eq([100, 100, 100, 100]), [], 2);
    expect(m.exposurePct).toBeCloseTo(0.5, 6);
  });
});

import { describe, it, expect } from "vitest";
import { computeMetrics } from "@/lib/backtest/metrics";
import type { EquityPoint, RealizationEvent } from "@/lib/backtest/types";

const eq = (vals: number[], stepHours = 1): EquityPoint[] =>
  vals.map((v, i) => ({ ts: i * stepHours * 3600_000, equityUsd: v }));

const realization = (over: Partial<RealizationEvent> & Pick<RealizationEvent, "pnlUsd">): RealizationEvent => ({
  ts: 0,
  symbol: "BTC",
  qty: 1,
  exitPrice: 100,
  costBasisUsd: 100,
  feeUsd: 0,
  closesPosition: true,
  kind: "market",
  ...over,
});

describe("computeMetrics", () => {
  it("total return a kezdő és vég equity arányából", () => {
    const m = computeMetrics(eq([100, 110]), [], 1);
    expect(m.totalReturnPct).toBeCloseTo(0.1, 6);
  });

  it("max drawdown a legnagyobb csúcs→völgy esés", () => {
    const m = computeMetrics(eq([100, 120, 90, 130]), [], 4);
    expect(m.maxDrawdownPct).toBeCloseTo(0.25, 6);
  });

  it("hit rate és profit factor MINDEN realizálásból", () => {
    const m = computeMetrics(
      eq([100, 105]),
      [realization({ pnlUsd: 10 }), realization({ symbol: "ETH", pnlUsd: -5 })],
      2,
    );
    expect(m.hitRate).toBeCloseTo(0.5, 6);
    expect(m.tradesCount).toBe(2);
    expect(m.profitFactor).toBeCloseTo(2, 6);
    expect(m.avgWinPct).toBeCloseTo(0.1, 6);
    expect(m.avgLossPct).toBeCloseTo(-0.05, 6);
  });

  it("AUDIT §7: a RÉSZLEGES realizálás is számít", () => {
    const m = computeMetrics(
      eq([100, 105]),
      [
        realization({ pnlUsd: 8, closesPosition: false, kind: "take-profit", costBasisUsd: 50 }),
        realization({ pnlUsd: -2, closesPosition: true, kind: "stop-loss", costBasisUsd: 50 }),
      ],
      2,
    );
    // A régi kód csak a VÉGSŐ eladást számolta volna (1 trade, 0% hit rate).
    expect(m.tradesCount).toBe(2);
    expect(m.hitRate).toBeCloseTo(0.5, 6);
    expect(m.profitFactor).toBeCloseTo(4, 6);
  });

  it("veszteség nélkül a profit factor NEM Infinity, hanem explicit jelölés", () => {
    const m = computeMetrics(eq([100, 120]), [realization({ pnlUsd: 20 })], 1);
    expect(m.profitFactor).toBeNull();
    expect(m.profitFactorInfinite).toBe(true);
    // JSON-biztos: nincs Infinity a szerializált alakban.
    expect(JSON.stringify(m)).not.toContain("Infinity");
    expect(JSON.parse(JSON.stringify(m)).profitFactor).toBeNull();
  });

  it("üres equity → nulla metrikák, nem dob", () => {
    const m = computeMetrics([], [], 0);
    expect(m.totalReturnPct).toBe(0);
    expect(m.sharpe).toBe(0);
    expect(m.profitFactor).toBeNull();
    expect(m.profitFactorInfinite).toBe(false);
  });

  it("exposure a piacban töltött órák aránya", () => {
    const m = computeMetrics(eq([100, 100, 100, 100]), [], 2);
    expect(m.exposurePct).toBeCloseTo(0.5, 6);
  });

  it("a Sharpe évesítése a TÉNYLEGES mintavételi közhöz igazodik", () => {
    const values = [100, 101, 100.5, 102, 101.5, 103];
    const hourly = computeMetrics(eq(values), [], 0, { samplingHours: 1 });
    const daily = computeMetrics(eq(values, 24), [], 0, { samplingHours: 24 });
    // Ugyanaz a hozam-sorozat, de napi mintavétellel kisebb az évesítő szorzó.
    expect(Math.abs(hourly.sharpe)).toBeGreaterThan(Math.abs(daily.sharpe));
    expect(hourly.samplingHours).toBe(1);
    expect(daily.samplingHours).toBe(24);
    expect(daily.sharpe).toBeCloseTo(hourly.sharpe / Math.sqrt(24), 6);
  });

  it("a díjak összesítve látszanak", () => {
    const m = computeMetrics(eq([100, 100]), [realization({ pnlUsd: 1, feeUsd: 0.25 })], 1);
    expect(m.totalFeesUsd).toBeCloseTo(0.25, 9);
  });

  it("csak nyerő és csak vesztes sorozat sem dob", () => {
    const wins = computeMetrics(eq([100, 110]), [realization({ pnlUsd: 5 }), realization({ pnlUsd: 5 })], 1);
    expect(wins.hitRate).toBe(1);
    const losses = computeMetrics(eq([100, 90]), [realization({ pnlUsd: -5 })], 1);
    expect(losses.hitRate).toBe(0);
    expect(losses.profitFactor).toBeCloseTo(0, 9);
  });
});

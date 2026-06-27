import { describe, it, expect } from "vitest";
import { simulateFill } from "@/lib/backtest/fill-sim";
import type { Candle } from "@/lib/backtest/types";

const candle = (o: number, h: number, l: number, c: number): Candle => ({
  ts: 0,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 0,
});

describe("simulateFill", () => {
  it("stop-loss a trigger-áron tölt (nincs gap), slippage-dzsel lefelé", () => {
    const f = simulateFill(
      { side: "SELL", kind: "stop-loss", qty: 2, triggerPrice: 100, candle: candle(105, 106, 99, 101) },
      0.001,
      10, // 0.1% fee, 10 bps slip
    )!;
    // base = min(100, open 105) = 100; fill = 100 * (1 - 0.001) = 99.9
    expect(f.fillPrice).toBeCloseTo(99.9, 6);
    expect(f.qty).toBeCloseTo(2, 6);
    expect(f.amountUsd).toBeCloseTo(99.9 * 2, 4);
  });

  it("stop-loss GAP-down: a rosszabb open-on tölt", () => {
    const f = simulateFill(
      { side: "SELL", kind: "stop-loss", qty: 1, triggerPrice: 100, candle: candle(94, 95, 90, 93) },
      0,
      0,
    )!;
    // a gyertya a stop ALÁ nyit (open 94 < 100) → base = min(100, 94) = 94
    expect(f.fillPrice).toBeCloseTo(94, 6);
  });

  it("take-profit GAP-up: a jobb open-on tölt", () => {
    const f = simulateFill(
      { side: "SELL", kind: "take-profit", qty: 1, triggerPrice: 100, candle: candle(108, 110, 107, 109) },
      0,
      0,
    )!;
    // base = max(100, open 108) = 108
    expect(f.fillPrice).toBeCloseTo(108, 6);
  });

  it("market BUY a close-on + slippage felfelé + fee", () => {
    const f = simulateFill(
      { side: "BUY", kind: "market", amountUsd: 100, candle: candle(50, 51, 49, 50) },
      0.001,
      20, // 20 bps
    )!;
    // fillPrice = 50 * (1 + 0.002) = 50.1; qty = (100 - fee) / 50.1
    expect(f.fillPrice).toBeCloseTo(50.1, 6);
    expect(f.feeUsd).toBeCloseTo(0.1, 6);
    expect(f.qty).toBeCloseTo((100 - 0.1) / 50.1, 6);
    expect(f.amountUsd).toBeCloseTo(100, 6);
  });

  it("market SELL a close-on - slippage", () => {
    const f = simulateFill(
      { side: "SELL", kind: "market", qty: 2, candle: candle(50, 51, 49, 50) },
      0,
      20,
    )!;
    expect(f.fillPrice).toBeCloseTo(49.9, 6); // 50 * (1 - 0.002)
  });

  it("nulla qty/amount → null", () => {
    expect(
      simulateFill(
        { side: "SELL", kind: "stop-loss", qty: 0, triggerPrice: 100, candle: candle(100, 100, 100, 100) },
        0,
        0,
      ),
    ).toBeNull();
  });
});

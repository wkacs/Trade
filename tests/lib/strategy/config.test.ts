import { describe, it, expect } from "vitest";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import { RISK_LIMITS, PROFIT_CYCLE } from "@/lib/config";

describe("DEFAULT_STRATEGY", () => {
  it("a mai RISK_LIMITS-szel egyezik", () => {
    expect(DEFAULT_STRATEGY.stopLossPct).toBe(RISK_LIMITS.stopLossPct);
    expect(DEFAULT_STRATEGY.maxPositionPct).toBe(RISK_LIMITS.maxPositionPct);
    expect(DEFAULT_STRATEGY.maxConcurrentPositions).toBe(RISK_LIMITS.maxConcurrentPositions);
    expect(DEFAULT_STRATEGY.dailyLossCircuitBreakerPct).toBe(RISK_LIMITS.dailyLossCircuitBreakerPct);
  });
  it("a mai PROFIT_CYCLE-lel egyezik", () => {
    expect(DEFAULT_STRATEGY.takeProfitPct).toBe(PROFIT_CYCLE.takeProfitPct);
    expect(DEFAULT_STRATEGY.dcaFgThreshold).toBe(PROFIT_CYCLE.dcaFgThreshold);
    expect(DEFAULT_STRATEGY.dcaWeeklyBudgetPct).toBe(PROFIT_CYCLE.dcaWeeklyBudgetPct);
    expect(DEFAULT_STRATEGY.dcaBuyPct).toBe(PROFIT_CYCLE.dcaBuyPct);
    expect(DEFAULT_STRATEGY.dcaMax24hDropPct).toBe(PROFIT_CYCLE.dcaMax24hDropPct);
  });
  it("alapból a hangolt módok: fixed stop, trend-szűrő BE, teljes take-profit", () => {
    expect(DEFAULT_STRATEGY.stopMode).toBe("fixed");
    expect(DEFAULT_STRATEGY.entryFilter).toBe("trend");
    expect(DEFAULT_STRATEGY.takeProfitFraction).toBe(1.0);
  });

  it("a hangolt live stratégia: trend-szűrő BE + a hangolt TP/FG (Approach A)", () => {
    expect(DEFAULT_STRATEGY.entryFilter).toBe("trend");
    expect(DEFAULT_STRATEGY.takeProfitPct).toBe(0.1); // a Task 2 nyertese szerint
    expect(DEFAULT_STRATEGY.takeProfitFraction).toBe(1.0);
    expect(DEFAULT_STRATEGY.dcaFgThreshold).toBe(20);
  });

  it("az új profit-boost mezők alapból KIKAPCSOLTAK (regresszió-őr)", () => {
    expect(DEFAULT_STRATEGY.momentumEnabled).toBe(false);
    expect(DEFAULT_STRATEGY.riskPerTradePct).toBe(0);
    expect(DEFAULT_STRATEGY.momentumSmaPeriod).toBe(24);
    expect(DEFAULT_STRATEGY.momentumLookback).toBe(48);
    expect(DEFAULT_STRATEGY.momentumBuyPct).toBe(0.02);
  });
});

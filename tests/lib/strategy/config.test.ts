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
  it("alapból a mai módok: fixed stop, szűrő off, fél take-profit", () => {
    expect(DEFAULT_STRATEGY.stopMode).toBe("fixed");
    expect(DEFAULT_STRATEGY.entryFilter).toBe("off");
    expect(DEFAULT_STRATEGY.takeProfitFraction).toBe(0.5);
  });
});

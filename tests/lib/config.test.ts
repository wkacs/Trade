import { describe, it, expect } from "vitest";
import { RISK_LIMITS, COIN_UNIVERSE, getTradingMode } from "@/lib/config";

describe("config", () => {
  it("konzervatív limitlek vannak beállítva", () => {
    expect(RISK_LIMITS.maxPositionPct).toBe(0.2);
    expect(RISK_LIMITS.stopLossPct).toBe(0.05);
    expect(RISK_LIMITS.leverage).toBe(1);
    expect(RISK_LIMITS.maxConcurrentPositions).toBe(3);
    expect(RISK_LIMITS.dailyLossCircuitBreakerPct).toBe(0.03);
  });

  it("BTC, ETH, SOL a coin kosár", () => {
    expect(COIN_UNIVERSE).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("alapértelmezetten paper módban vagyunk", () => {
    expect(getTradingMode()).toBe("paper");
  });
});

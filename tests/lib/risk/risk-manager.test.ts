import { describe, it, expect } from "vitest";
import { applyRisk, type RiskContext } from "@/lib/risk/risk-manager";
import type { RawDecision } from "@/lib/types";

const ctx = (
  cash: number,
  positions: { symbol: string; valueUsd: number }[] = [],
  dayPnlPct = 0,
): RiskContext => ({
  cashUsd: cash,
  positions,
  totalEquity: () => cash + positions.reduce((s, p) => s + p.valueUsd, 0),
  dayPnlPct,
});

const buy = (symbol: string, amountPct: number, confidence = 0.8): RawDecision => ({
  action: "BUY",
  symbol,
  amountPct,
  confidence,
  reasoning: "x",
  model: "glm-5.2",
});

describe("applyRisk — kockázati limitek", () => {
  it("HOLD átmegy változatlanul", () => {
    const raw: RawDecision = { action: "HOLD", symbol: "BTC", amountPct: 0, confidence: 0.5, reasoning: "x", model: "glm-5.2" };
    const result = applyRisk(raw, ctx(10000));
    expect(result.action).toBe("HOLD");
    expect(result.overridden).toBe(false);
  });

  it("20% feletti pozíciót visszavágja 20%-ra", () => {
    const result = applyRisk(buy("BTC", 0.5), ctx(10000));
    expect(result.amountPct).toBe(0.2);
    expect(result.overridden).toBe(true);
    expect(result.overrideReason).toMatch(/20%/);
  });

  it("pont 20% megengedett", () => {
    const result = applyRisk(buy("BTC", 0.2), ctx(10000));
    expect(result.amountPct).toBe(0.2);
    expect(result.overridden).toBe(false);
  });

  it("ha már 3 KÜLÖNBÖZŐ pozíció van és ÚJ coinra BUY jön → HOLD", () => {
    // A kosár csak BTC/ETH/SOL — szimuláljuk: mindhárom nyitva, újra próbálkozunk,
    // de mivel nincs 4. coin, ezt egy nem-kosáros szimbólummal demonstráljuk
    const positions = [
      { symbol: "BTC", valueUsd: 1000 },
      { symbol: "ETH", valueUsd: 1000 },
      { symbol: "SOL", valueUsd: 1000 },
    ];
    const result = applyRisk(buy("ADA", 0.1), ctx(7000, positions));
    expect(result.action).toBe("HOLD");
    expect(result.overridden).toBe(true);
    expect(result.overrideReason).toMatch(/pozíció/i);
  });

  it("már nyitott coinra BUY nem számít új pozíciónak (átenged)", () => {
    const positions = [
      { symbol: "BTC", valueUsd: 1000 },
      { symbol: "ETH", valueUsd: 1000 },
      { symbol: "SOL", valueUsd: 1000 },
    ];
    const result = applyRisk(buy("BTC", 0.1), ctx(7000, positions));
    expect(result.action).toBe("BUY");
    expect(result.overridden).toBe(false);
  });

  it("napi -3% circuit breaker HOLD-onlyvá tesz", () => {
    const result = applyRisk(buy("BTC", 0.1), ctx(9700, [], -0.031));
    expect(result.action).toBe("HOLD");
    expect(result.overridden).toBe(true);
    expect(result.overrideReason).toMatch(/circuit breaker|napi/i);
  });

  it("-2.9% még nem aktiválja a breakert", () => {
    const result = applyRisk(buy("BTC", 0.1), ctx(9710, [], -0.029));
    expect(result.action).toBe("BUY");
    expect(result.overridden).toBe(false);
  });

  it("döntés kap egy id-t és timestampet", () => {
    const result = applyRisk(buy("BTC", 0.1), ctx(10000));
    expect(result.id).toBeTruthy();
    expect(result.timestamp).toBeGreaterThan(0);
  });
});

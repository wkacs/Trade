import { describe, it, expect } from "vitest";
import { buildTickProcess, type TickProcessInput } from "@/lib/engine/tick-process";

const base: TickProcessInput = {
  tickId: "2026-06-28-11",
  prices: { BTC: 60000, SOL: 150 },
  fearGreed: { value: 15, classification: "Extreme Fear" },
  mlSignals: [{ symbol: "BTC", direction1h: "up", confidence: 0.55 }],
  cycleActions: [{ kind: "dca", side: "BUY", symbol: "SOL", amountUsd: 20, qty: 0.13 }],
  phase1: { shouldDecide: false, summary: "csendes piac" },
  phase2: null,
  decision: { action: "HOLD", symbol: null, overridden: false, overrideReason: null },
  aiTrade: null,
};

describe("buildTickProcess", () => {
  it("a cycleActions-ből trade-et készít az eredettel (kind = origin)", () => {
    const p = buildTickProcess(base);
    expect(p.trades).toEqual([{ symbol: "SOL", side: "BUY", origin: "dca", amountUsd: 20 }]);
    expect(p.inputs.fearGreed?.value).toBe(15);
    expect(p.phase2).toBeNull();
  });

  it("az AI-trade-et 'ai' eredettel hozzáfűzi a cycle-trade-ek után", () => {
    const p = buildTickProcess({
      ...base,
      cycleActions: [],
      phase1: { shouldDecide: true, summary: "ETF hír" },
      phase2: { action: "BUY", symbol: "BTC", amountPct: 0.1, confidence: 0.7, reasoning: "bullish" },
      decision: { action: "BUY", symbol: "BTC", overridden: false, overrideReason: null },
      aiTrade: { symbol: "BTC", side: "BUY", amountUsd: 100 },
    });
    expect(p.trades).toEqual([{ symbol: "BTC", side: "BUY", origin: "ai", amountUsd: 100 }]);
    expect(p.phase2?.action).toBe("BUY");
  });
});

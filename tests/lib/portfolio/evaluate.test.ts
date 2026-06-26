import { describe, it, expect } from "vitest";
import { scoreDecision, type DecisionRef } from "@/lib/portfolio/evaluate";

const ref = (over: Partial<DecisionRef> = {}): DecisionRef => ({
  prices: { BTC: 60000, ETH: 3000, SOL: 150 },
  intent: "BUY",
  intentSymbol: "BTC",
  intentAmountPct: 0.1,
  ...over,
});

describe("scoreDecision (bejott volna?)", () => {
  it("BUY + emelkedés → nyereséges lett volna", () => {
    const o = scoreDecision(ref({ intent: "BUY", intentSymbol: "BTC" }), { BTC: 63000 }, 1);
    expect(o.refSymbol).toBe("BTC");
    expect(o.changePct).toBeCloseTo(5, 6); // (63000-60000)/60000
    expect(o.hypotheticalPnlPct).toBeCloseTo(5, 6);
    expect(o.wouldProfit).toBe(true);
  });

  it("BUY + esés → bukó lett volna", () => {
    const o = scoreDecision(ref({ intent: "BUY", intentSymbol: "ETH" }), { ETH: 2850 }, 1);
    expect(o.hypotheticalPnlPct).toBeCloseTo(-5, 6);
    expect(o.wouldProfit).toBe(false);
  });

  it("SELL + esés → jó döntés (a SELL nyer esésnél)", () => {
    const o = scoreDecision(ref({ intent: "SELL", intentSymbol: "SOL" }), { SOL: 135 }, 1);
    // changePct = -10, SELL hypothetical = +10
    expect(o.changePct).toBeCloseTo(-10, 6);
    expect(o.hypotheticalPnlPct).toBeCloseTo(10, 6);
    expect(o.wouldProfit).toBe(true);
  });

  it("HOLD → semleges (wouldProfit null), a BTC piaci mozgást rögzíti", () => {
    const o = scoreDecision(ref({ intent: "HOLD", intentSymbol: null }), { BTC: 61200 }, 1);
    expect(o.wouldProfit).toBeNull();
    expect(o.changePct).toBeCloseTo(2, 6); // BTC +2%
    expect(o.hypotheticalPnlPct).toBe(0);
  });
});

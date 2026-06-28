import { describe, it, expect } from "vitest";
import { sizeEntry } from "@/lib/strategy/sizing";

const base = { stopLossPct: 0.05, stopMode: "fixed" as const, maxPositionPct: 0.2, flatPct: 0.02 };

describe("sizeEntry", () => {
  it("riskPerTradePct=0 → flat: equity*flatPct", () => {
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0 })).toBeCloseTo(20); // 1000*0.02
  });

  it("kockázat-alapú fix stopnál: risk/stopLoss, maxPositionPct-re vágva", () => {
    // 0.01*1000 / 0.05 = 200, de maxPositionPct 0.2*1000=200 → 200
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0.01 })).toBeCloseTo(200);
    // 0.005*1000 / 0.05 = 100 (< 200 cap) → 100
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0.005 })).toBeCloseTo(100);
  });

  it("atr stopnál a kockázat-méret nem alkalmazható → flat", () => {
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0.01, stopMode: "atr" })).toBeCloseTo(20);
  });

  it("degenerált stopLossPct=0 → flat (nincs nullával osztás)", () => {
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0.01, stopLossPct: 0 })).toBeCloseTo(20);
  });
});

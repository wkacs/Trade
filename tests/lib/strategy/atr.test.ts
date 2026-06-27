import { describe, it, expect } from "vitest";
import { computeAtr } from "@/lib/strategy/atr";

const c = (high: number, low: number, close: number) => ({ high, low, close });

describe("computeAtr", () => {
  it("TR = max(h-l, |h-prevClose|, |l-prevClose|), majd átlag", () => {
    // i=1: h12 l9 pc10 → max(3,2,1)=3; i=2: h14 l11 pc11 → max(3,3,0)=3 → avg 3
    const atr = computeAtr([c(11, 10, 10), c(12, 9, 11), c(14, 11, 13)], 14);
    expect(atr).toBeCloseTo(3, 6);
  });
  it("period ablakot vesz (csak az utolsó N TR)", () => {
    const atr = computeAtr([c(10, 9, 10), c(11, 10, 11), c(20, 10, 15)], 1);
    // period 1 → utolsó TR: h20 l10 pc11 → max(10,9,1)=10
    expect(atr).toBeCloseTo(10, 6);
  });
  it("<2 gyertya → 0 (nem dob)", () => {
    expect(computeAtr([c(10, 9, 10)], 14)).toBe(0);
    expect(computeAtr([], 14)).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { sma, passesTrendFilter } from "@/lib/strategy/entry-filter";

describe("entry-filter", () => {
  it("sma az utolsó N érték átlaga", () => {
    expect(sma([10, 20, 30, 40], 2)).toBeCloseTo(35, 6); // (30+40)/2
  });
  it("átmegy, ha az utolsó close ≥ SMA (nem lefelé trend)", () => {
    expect(passesTrendFilter([10, 11, 12, 13], 4)).toBe(true); // 13 ≥ 11.5
  });
  it("kiesik, ha az utolsó close < SMA (lefelé trend)", () => {
    expect(passesTrendFilter([20, 18, 14, 10], 4)).toBe(false); // 10 < 15.5
  });
  it("üres input → átmegy (nem blokkol vakon)", () => {
    expect(passesTrendFilter([], 4)).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import {
  add,
  sub,
  mul,
  div,
  cmp,
  dec,
  round,
  floorToStep,
  sum,
  isDecimalString,
  MoneyError,
  toUnits,
  fromUnits,
  min,
  max,
  neg,
  abs,
} from "@/lib/portfolio/money";

describe("money — decimális aritmetika lebegőpontos hiba nélkül", () => {
  it("a 0.1 + 0.2 pontosan 0.3 (a double-lel ez 0.30000000000000004)", () => {
    expect(add("0.1", "0.2")).toBe("0.3");
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("kivonás és összegzés pontos", () => {
    expect(sub("100", "0.09354296")).toBe("99.90645704");
    expect(sum(["0.1", "0.2", "0.3"])).toBe("0.6");
    expect(sum([])).toBe("0");
  });

  it("szorzás half-up kerekítéssel, 18 tizedesig", () => {
    expect(mul("0.001688317", "59000")).toBe("99.610703");
    expect(mul("-2", "3")).toBe("-6");
  });

  it("osztás half-up kerekítéssel; nullával osztás hibát dob", () => {
    expect(div("1", "3")).toBe("0.333333333333333333");
    expect(div("60", "60000")).toBe("0.001");
    expect(() => div("1", "0")).toThrow(MoneyError);
  });

  it("összehasonlítás, min/max, előjel", () => {
    expect(cmp("0.1", "0.2")).toBe(-1);
    expect(cmp("0.30", "0.3")).toBe(0);
    expect(min("2", "1.5")).toBe("1.5");
    expect(max("2", "1.5")).toBe("2");
    expect(neg("2.5")).toBe("-2.5");
    expect(abs("-2.5")).toBe("2.5");
  });

  it("kanonikus alak: nincs -0 és nincs felesleges nulla", () => {
    expect(sub("1", "1")).toBe("0");
    expect(mul("-0.0", "5")).toBe("0");
    expect(dec("1.500")).toBe("1.5");
    expect(fromUnits(toUnits("0.000000000000000001"))).toBe("0.000000000000000001");
  });
});

describe("money — bemenet-validálás (nincs csendes 0-ra esés)", () => {
  it("elutasítja a NaN, Infinity, exponenciális és üres bemenetet", () => {
    for (const bad of ["NaN", "Infinity", "-Infinity", "1e5", "", " ", "abc", "1.2.3", "--1"]) {
      expect(isDecimalString(bad)).toBe(false);
      expect(() => toUnits(bad)).toThrow(MoneyError);
    }
  });

  it("elutasítja a 18 tizedesnél pontosabb bemenetet (nem csonkol csendben)", () => {
    expect(isDecimalString("0.1234567890123456789")).toBe(false);
    expect(isDecimalString("0.123456789012345678")).toBe(true);
  });

  it("a dec(number) kompatibilitási út feloldja az exponenciális alakot", () => {
    expect(dec(1e-7)).toBe("0.0000001");
    expect(dec(0)).toBe("0");
    expect(() => dec(Number.NaN)).toThrow(MoneyError);
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe("money — dokumentált kerekítés", () => {
  it("a mód kötelező: floor, ceil és half-up eltérő eredményt ad", () => {
    expect(round("1.005", 2, "floor")).toBe("1");
    expect(round("1.005", 2, "ceil")).toBe("1.01");
    expect(round("1.005", 2, "half-up")).toBe("1.01");
    expect(round("1.004", 2, "half-up")).toBe("1");
  });

  it("negatív értéken a floor lefelé, a ceil felfelé kerekít", () => {
    expect(round("-1.5", 0, "floor")).toBe("-2");
    expect(round("-1.5", 0, "ceil")).toBe("-1");
    expect(round("-1.5", 0, "half-up")).toBe("-2");
  });

  it("érvénytelen tizedesjegy-számra hibát dob", () => {
    expect(() => round("1", -1, "floor")).toThrow(MoneyError);
    expect(() => round("1", 19, "floor")).toThrow(MoneyError);
  });

  it("floorToStep: tetszőleges tőzsdei lépésközre kerekít lefelé", () => {
    expect(floorToStep("0.123456789", "0.00001")).toBe("0.12345");
    expect(floorToStep("12.7", "0.5")).toBe("12.5");
    expect(floorToStep("0.00000009", "0.0000001")).toBe("0");
    expect(() => floorToStep("1", "0")).toThrow(MoneyError);
    expect(() => floorToStep("-1", "0.1")).toThrow(MoneyError);
  });
});

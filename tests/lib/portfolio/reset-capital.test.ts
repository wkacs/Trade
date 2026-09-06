import { describe, expect, it } from "vitest";
import { quoteCapitalFromHuf } from "@/lib/portfolio/reset-capital";

describe("quoteCapitalFromHuf", () => {
  it("100 000 Ft-ot a megadott hivatalos USD/HUF árfolyamon 8 tizedesre vált", () => {
    expect(quoteCapitalFromHuf(100_000, 312.78)).toBe("319.71353667");
  });

  it("elutasítja a nem pozitív keretet és árfolyamot", () => {
    expect(() => quoteCapitalFromHuf(0, 312.78)).toThrow("pozitív");
    expect(() => quoteCapitalFromHuf(100_000, 0)).toThrow("pozitív");
  });
});

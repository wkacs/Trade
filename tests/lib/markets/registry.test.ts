import { describe, it, expect } from "vitest";
import {
  activeInstruments,
  activeByClass,
  findInstrument,
  INSTRUMENT_CATALOG,
} from "@/lib/markets/registry";

describe("markets/registry", () => {
  it("alapból PONTOSAN a mai kripto-kosár aktív (nem töri a runtime-ot)", () => {
    const active = activeInstruments({});
    expect(active.map((i) => i.symbol)).toEqual(["BTC", "ETH", "SOL"]);
    expect(active.every((i) => i.assetClass === "crypto")).toBe(true);
  });

  it("MARKETS_EXTRA_CRYPTO hozzávesz a katalógusból egyezőket", () => {
    const active = activeInstruments({ MARKETS_EXTRA_CRYPTO: "bnb, xrp" });
    expect(active.map((i) => i.symbol)).toContain("BNB");
    expect(active.map((i) => i.symbol)).toContain("XRP");
    expect(active.map((i) => i.symbol)).not.toContain("ADA");
  });

  it("ismeretlen extra szimbólumot csendben kihagy", () => {
    const active = activeInstruments({ MARKETS_EXTRA_CRYPTO: "FOO,BNB" });
    expect(active.map((i) => i.symbol)).toContain("BNB");
    expect(active.map((i) => i.symbol)).not.toContain("FOO");
  });

  it("MARKETS_ENABLE_STOCKS bekapcsolja a részvény-katalógust", () => {
    const active = activeInstruments({ MARKETS_ENABLE_STOCKS: "1" });
    const stocks = active.filter((i) => i.assetClass === "stock");
    expect(stocks.length).toBeGreaterThan(0);
    expect(stocks.every((i) => i.quote === "USD" && i.dataProvider === "yahoo")).toBe(true);
    expect(active.map((i) => i.symbol)).toContain("AAPL");
  });

  it("false/üres flag nem kapcsol be részvényt", () => {
    expect(activeByClass("stock", { MARKETS_ENABLE_STOCKS: "false" })).toEqual([]);
    expect(activeByClass("stock", {})).toEqual([]);
  });

  it("findInstrument a teljes katalógusból keres, kis/nagybetűtől függetlenül", () => {
    expect(findInstrument("aapl")?.providerSymbol).toBe("AAPL");
    expect(findInstrument("BTC")?.assetClass).toBe("crypto");
    expect(findInstrument("NOPE")).toBeUndefined();
  });

  it("minden katalógus-instrumentum kötelező mezői ki vannak töltve", () => {
    for (const inst of INSTRUMENT_CATALOG) {
      expect(inst.symbol).toMatch(/^[A-Z0-9]+$/);
      expect(["crypto", "stock"]).toContain(inst.assetClass);
      expect(inst.quote.length).toBeGreaterThan(0);
      expect(inst.providerSymbol.length).toBeGreaterThan(0);
    }
  });
});

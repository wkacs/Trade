import { describe, it, expect } from "vitest";
import { holdReason } from "@/lib/llm/hold-reason";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import type { DataPoint } from "@/lib/types";

const price = (symbol: string, usd: number, change24hPct: number): DataPoint => ({
  source: "coingecko",
  symbol,
  timestamp: 1,
  kind: "price",
  price: { usd, volume24h: 0, change24hPct },
});

const fearGreed = (value: number, classification: string): DataPoint => ({
  source: "alternative",
  symbol: "MARKET",
  timestamp: 1,
  kind: "sentiment",
  sentiment: { value, classification },
});

describe("holdReason – a HOLD indoka a TÉNYLEGESEN kiértékelt kapukból", () => {
  const events = [price("BTC", 78446, -1.27), price("ETH", 2482, -0.63), fearGreed(69, "Greed")];

  it("megnevezi a fear-DCA kaput a valódi F&G értékkel és küszöbbel", () => {
    const r = holdReason(events, DEFAULT_STRATEGY);
    expect(r).toContain("F&G 69");
    expect(r).toContain(String(DEFAULT_STRATEGY.dcaFgThreshold));
  });

  it("kimondja, ha a momentum-belépő ki van kapcsolva (ez a másik belépő út)", () => {
    const r = holdReason(events, { ...DEFAULT_STRATEGY, momentumEnabled: false });
    expect(r).toContain("momentum-belépő kikapcsolva");
  });

  it("bekapcsolt momentumnál nem állítja, hogy ki van kapcsolva", () => {
    const r = holdReason(events, { ...DEFAULT_STRATEGY, momentumEnabled: true });
    expect(r).not.toContain("kikapcsolva");
    expect(r).toContain("momentum-belépő aktív");
  });

  it("nyitott fear-kapunál azt mondja, hogy a kapu NYITVA van", () => {
    const r = holdReason([price("BTC", 50000, -9), fearGreed(12, "Extreme Fear")], DEFAULT_STRATEGY);
    expect(r).toContain("nyitva");
  });

  it("felsorolja a 24 órás elmozdulásokat, előjellel", () => {
    const r = holdReason(events, DEFAULT_STRATEGY);
    expect(r).toContain("BTC −1,3%");
    expect(r).toContain("ETH −0,6%");
  });

  it("F&G adat nélkül NEM talál ki értéket", () => {
    const r = holdReason([price("BTC", 78446, -1.27)], DEFAULT_STRATEGY);
    expect(r).toContain("nincs F&G adat");
    expect(r).not.toMatch(/F&G \d/);
  });

  it("az LLM kiesésének OKÁT is megnevezi, ha volt ilyen", () => {
    const r = holdReason(events, DEFAULT_STRATEGY, { errorCode: "rate_limited" });
    expect(r).toContain("rate_limited");
  });

  it("LLM-hiba nélkül nem beszél LLM-ről", () => {
    expect(holdReason(events, DEFAULT_STRATEGY)).not.toContain("AI-vélemény");
  });

  it("üres esemény-listával sem dob, és nem állít semmit a piacról", () => {
    const r = holdReason([], DEFAULT_STRATEGY);
    expect(r.length).toBeGreaterThan(0);
    expect(r).toContain("nincs F&G adat");
  });
});

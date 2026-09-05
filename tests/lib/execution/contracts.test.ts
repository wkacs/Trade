import { describe, it, expect } from "vitest";
import {
  EXECUTION_CONTRACT_VERSION,
  ContractError,
  validateOrder,
  validateIntent,
  validateFill,
  isIntentExpired,
  fillKey,
  clientOrderId,
  fromLegacyOrder,
  toLegacyOrder,
  isRealFill,
  type ExecutionIntent,
} from "@/lib/execution/contracts";

const baseIntent = {
  intentId: "6f1c2f2e-1111-2222-3333-444455556666",
  portfolioId: "pf-1",
  mode: "paper" as const,
  strategyVersion: "v2-2026-09-05",
  origin: "dca" as const,
  expiresAt: 1_700_000_060_000,
  contractVersion: EXECUTION_CONTRACT_VERSION,
  referencePrice: "60000",
  order: { side: "BUY" as const, symbol: "BTC", maxQuoteSpend: "2" },
};

describe("validateOrder — BUY quote-budget és SELL base-qty megkülönböztetése", () => {
  it("BUY-t maxQuoteSpend-del fogad el", () => {
    expect(validateOrder({ side: "BUY", symbol: "BTC", maxQuoteSpend: "2.5" })).toEqual({
      side: "BUY",
      symbol: "BTC",
      maxQuoteSpend: "2.5",
    });
  });

  it("SELL-t baseQty-vel fogad el", () => {
    expect(validateOrder({ side: "SELL", symbol: "ETH", baseQty: "0.0125" })).toEqual({
      side: "SELL",
      symbol: "ETH",
      baseQty: "0.0125",
    });
  });

  it("BUY-nál elutasítja a baseQty-t (kétértelmű oldali mező)", () => {
    expect(() => validateOrder({ side: "BUY", symbol: "BTC", maxQuoteSpend: "1", baseQty: "1" })).toThrow(
      ContractError,
    );
  });

  it("SELL-nél elutasítja a maxQuoteSpend-et", () => {
    expect(() => validateOrder({ side: "SELL", symbol: "BTC", baseQty: "1", maxQuoteSpend: "1" })).toThrow(
      ContractError,
    );
  });

  it("elutasítja a hiányzó mennyiséget", () => {
    expect(() => validateOrder({ side: "BUY", symbol: "BTC" })).toThrow(/maxQuoteSpend/);
    expect(() => validateOrder({ side: "SELL", symbol: "BTC" })).toThrow(/baseQty/);
  });

  it("elutasítja a negatív, nulla, NaN és Infinity mennyiséget", () => {
    for (const bad of ["-1", "0", "NaN", "Infinity", "-Infinity", "1e5", "", "abc"]) {
      expect(() => validateOrder({ side: "BUY", symbol: "BTC", maxQuoteSpend: bad })).toThrow(ContractError);
    }
    // A number típusú bemenet sem megy át: a szerződés decimális SZÖVEGET vár.
    expect(() => validateOrder({ side: "BUY", symbol: "BTC", maxQuoteSpend: 2 })).toThrow(ContractError);
    expect(() => validateOrder({ side: "BUY", symbol: "BTC", maxQuoteSpend: Number.NaN })).toThrow(ContractError);
  });

  it("elutasítja az érvénytelen oldalt és szimbólumot", () => {
    expect(() => validateOrder({ side: "HOLD", symbol: "BTC", maxQuoteSpend: "1" })).toThrow(/side/);
    expect(() => validateOrder({ side: "BUY", symbol: "btc", maxQuoteSpend: "1" })).toThrow(/symbol/);
    expect(() => validateOrder({ side: "BUY", symbol: "", maxQuoteSpend: "1" })).toThrow(/symbol/);
  });
});

describe("validateIntent — azonosítók, mód és lejárat", () => {
  it("érvényes intentet visszaad", () => {
    const i = validateIntent(baseIntent);
    expect(i.intentId).toBe(baseIntent.intentId);
    expect(i.mode).toBe("paper");
    expect(i.contractVersion).toBe(2);
  });

  it("elutasítja a hiányzó vagy rossz contractVersion-t (v1 napló nem olvasható v2-ként)", () => {
    expect(() => validateIntent({ ...baseIntent, contractVersion: 1 })).toThrow(/contractVersion/);
    const { contractVersion, ...withoutVersion } = baseIntent;
    expect(() => validateIntent(withoutVersion)).toThrow(/contractVersion/);
  });

  it("elutasítja az ismeretlen módot és az üres azonosítókat", () => {
    expect(() => validateIntent({ ...baseIntent, mode: "demo" })).toThrow(/mode/);
    expect(() => validateIntent({ ...baseIntent, portfolioId: "" })).toThrow(/portfolioId/);
    expect(() => validateIntent({ ...baseIntent, strategyVersion: "" })).toThrow(/strategyVersion/);
  });

  it("elutasítja a nem véges lejáratot", () => {
    expect(() => validateIntent({ ...baseIntent, expiresAt: Number.POSITIVE_INFINITY })).toThrow(/expiresAt/);
    expect(() => validateIntent({ ...baseIntent, expiresAt: "soon" })).toThrow(/expiresAt/);
  });

  it("lejárat: az injektált idő dönt, nem a rendszeróra", () => {
    const i: ExecutionIntent = validateIntent(baseIntent);
    expect(isIntentExpired(i, i.expiresAt)).toBe(false);
    expect(isIntentExpired(i, i.expiresAt + 1)).toBe(true);
  });
});

describe("validateFill — tényleges teljesülés", () => {
  const goodFill = {
    fillId: "paper:o-1:t-1",
    intentId: baseIntent.intentId,
    portfolioId: "pf-1",
    mode: "paper" as const,
    symbol: "BTC",
    side: "BUY" as const,
    exchangeOrderId: "o-1",
    exchangeTradeId: "t-1",
    filledBaseQty: "0.00003333",
    grossQuoteAmount: "1.9998",
    fillPrice: "60000",
    feeAmount: "0.002",
    feeAsset: "USDT",
    executedAt: 1_700_000_000_000,
  };

  it("érvényes fillt elfogad, a díjeszközt megőrzi", () => {
    const f = validateFill(goodFill);
    expect(f.feeAsset).toBe("USDT");
    expect(f.feeAmount).toBe("0.002");
  });

  it("nulla mennyiségű vagy nulla bruttójú fillt elutasít (nyitott order nem trade)", () => {
    expect(() => validateFill({ ...goodFill, filledBaseQty: "0" })).toThrow(/filledBaseQty/);
    expect(() => validateFill({ ...goodFill, grossQuoteAmount: "0" })).toThrow(/grossQuoteAmount/);
  });

  it("negatív díjat elutasít, nullát elfogad (maker rebate nélküli eset)", () => {
    expect(() => validateFill({ ...goodFill, feeAmount: "-0.001" })).toThrow(/feeAmount/);
    expect(validateFill({ ...goodFill, feeAmount: "0" }).feeAmount).toBe("0");
  });

  it("hiányzó tőzsdei azonosítót elutasít", () => {
    expect(() => validateFill({ ...goodFill, exchangeOrderId: "" })).toThrow(/exchangeOrderId/);
    expect(() => validateFill({ ...goodFill, exchangeTradeId: "" })).toThrow(/exchangeTradeId/);
  });

  it("a dedup-kulcs a módot is tartalmazza (paper és live nem ütközik)", () => {
    expect(fillKey("paper", "o-1", "t-1")).toBe("paper:o-1:t-1");
    expect(fillKey("live", "o-1", "t-1")).not.toBe(fillKey("paper", "o-1", "t-1"));
  });

  it("isRealFill: csak pozitív mennyiség és bruttó számít teljesülésnek", () => {
    expect(isRealFill({ filledBaseQty: "0.1", grossQuoteAmount: "10" })).toBe(true);
    expect(isRealFill({ filledBaseQty: "0", grossQuoteAmount: "10" })).toBe(false);
  });
});

describe("clientOrderId — stabil azonosító az újraküldéshez", () => {
  it("ugyanabból az intentId-ból mindig ugyanaz", () => {
    expect(clientOrderId(baseIntent.intentId)).toBe(clientOrderId(baseIntent.intentId));
  });

  it("legfeljebb 36 karakter, és csak a Binance által elfogadott karakterek", () => {
    const id = clientOrderId(baseIntent.intentId);
    expect(id.length).toBeLessThanOrEqual(36);
    expect(id).toMatch(/^[.A-Z:/a-z0-9_-]{1,36}$/);
  });
});

describe("v1 ↔ v2 adapter — a régi runtime tovább fordul", () => {
  it("v1 BUY → v2 maxQuoteSpend", () => {
    expect(fromLegacyOrder({ side: "BUY", symbol: "BTC", amountUsd: 2, stopLossPct: 0.05 }, "60000")).toEqual({
      side: "BUY",
      symbol: "BTC",
      maxQuoteSpend: "2",
    });
  });

  it("v1 SELL → v2 baseQty az árból (a kétértelműség csak árral oldható fel)", () => {
    expect(fromLegacyOrder({ side: "SELL", symbol: "BTC", amountUsd: 60, stopLossPct: 0.05 }, "60000")).toEqual({
      side: "SELL",
      symbol: "BTC",
      baseQty: "0.001",
    });
  });

  it("oda-vissza konverzió megőrzi az USD-összeget", () => {
    const legacy = { side: "SELL" as const, symbol: "BTC", amountUsd: 60, stopLossPct: 0.05 };
    const v2 = fromLegacyOrder(legacy, "60000");
    expect(toLegacyOrder(v2, "60000", 0.05).amountUsd).toBeCloseTo(60, 10);
  });
});

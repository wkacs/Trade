import { describe, it, expect, vi } from "vitest";
import {
  parseExchangeInfo,
  roundPrice,
  roundQty,
  checkOrder,
  sizeBuy,
  sizeSell,
  protectionPrices,
  isStale,
  fetchSymbolFilters,
  pairFor,
  type SymbolFilters,
} from "@/lib/execution/exchange-rules";

const NOW = 1_700_000_000_000;

/** Valósághoz közeli BTCUSDT szűrők (a konkrét értékeket élesben az exchangeInfo adja). */
const btc: SymbolFilters = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  status: "TRADING",
  tickSize: "0.01",
  minPrice: "0.01",
  maxPrice: "1000000",
  stepSize: "0.00001",
  minQty: "0.00001",
  maxQty: "9000",
  marketStepSize: null,
  marketMinQty: null,
  marketMaxQty: null,
  minNotional: "5",
  applyMinToMarket: true,
  fetchedAt: NOW,
};

const exchangeInfoPayload = {
  symbols: [
    {
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      status: "TRADING",
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000.00", tickSize: "0.01" },
        { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000.00000000", stepSize: "0.00001" },
        { filterType: "MARKET_LOT_SIZE", minQty: "0.00000000", maxQty: "100.00000000", stepSize: "0.00000000" },
        { filterType: "NOTIONAL", minNotional: "5.00000000", applyMinToMarket: true },
      ],
    },
    // Hiányos szűrőkészlet: NEM pótoljuk kitalált értékkel.
    { symbol: "BADUSDT", baseAsset: "BAD", quoteAsset: "USDT", status: "TRADING", filters: [] },
  ],
};

describe("parseExchangeInfo — a szabályok a TŐZSDÉTŐL jönnek", () => {
  it("kiolvassa a tickSize, stepSize és minNotional értékeket", () => {
    const { filters } = parseExchangeInfo(exchangeInfoPayload, NOW);
    expect(filters.BTCUSDT.tickSize).toBe("0.01");
    expect(filters.BTCUSDT.stepSize).toBe("0.00001");
    expect(filters.BTCUSDT.minNotional).toBe("5");
    expect(filters.BTCUSDT.applyMinToMarket).toBe(true);
  });

  it("a hiányos szűrőkészletű szimbólum KIMARAD, nem kap kitalált értéket", () => {
    const { filters, skipped } = parseExchangeInfo(exchangeInfoPayload, NOW);
    expect(filters.BADUSDT).toBeUndefined();
    expect(skipped).toContainEqual({ symbol: "BADUSDT", reason: "missing_filters" });
  });

  it("értelmezhetetlen válasz esetén üres készlet", () => {
    const { filters, skipped } = parseExchangeInfo({ nonsense: true }, NOW);
    expect(filters).toEqual({});
    expect(skipped[0].reason).toBe("bad_payload");
  });
});

describe("kerekítés — nincs univerzális toFixed", () => {
  it("az ár LEFELÉ kerekül a tickSize-ra", () => {
    expect(roundPrice("60123.456789", btc)).toBe("60123.45");
    expect(roundPrice("0.009", btc)).toBe("0");
  });

  it("a mennyiség LEFELÉ kerekül a stepSize-ra", () => {
    expect(roundQty("0.000123456", btc)).toBe("0.00012");
    expect(roundQty("0.000009", btc)).toBe("0");
  });

  it("market ordernél a MARKET_LOT_SIZE lépésköze az irányadó, ha van", () => {
    const withMarket: SymbolFilters = { ...btc, marketStepSize: "0.001" };
    expect(roundQty("0.123456", withMarket, "MARKET")).toBe("0.123");
    expect(roundQty("0.123456", withMarket, "LIMIT")).toBe("0.12345");
  });

  it("eltérő lépésközű szimbólumon is helyes (nem BTC-re szabott)", () => {
    const sol: SymbolFilters = { ...btc, symbol: "SOLUSDT", tickSize: "0.001", stepSize: "0.01", minQty: "0.01" };
    expect(roundPrice("145.6789", sol)).toBe("145.678");
    expect(roundQty("1.239", sol)).toBe("1.23");
  });
});

describe("checkOrder — a KEREKÍTÉS UTÁNI érték a döntő", () => {
  it("a minimum notional alatti order elutasításra kerül", () => {
    const r = checkOrder({ symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", qty: "0.00001", price: "60000", nowMs: NOW }, btc);
    // 0.00001 * 60000 = 0.6 < 5
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("below_min_notional");
  });

  it("a minimum notional felett átmegy", () => {
    const r = checkOrder({ symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", qty: "0.0001", price: "60000", nowMs: NOW }, btc);
    expect(r.ok).toBe(true);
  });

  it("a minQty alatti mennyiség elutasításra kerül", () => {
    const r = checkOrder({ symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", qty: "0.000001", price: "60000", nowMs: NOW }, btc);
    expect(r.ok).toBe(false);
    expect(["below_min_qty", "below_min_notional"]).toContain(r.reason);
  });

  it("ismeretlen szimbólumra nincs order", () => {
    const r = checkOrder({ symbol: "XYZ", side: "BUY", orderType: "MARKET", qty: "1", price: "1", nowMs: NOW }, undefined);
    expect(r.reason).toBe("unknown_symbol");
  });

  it("nem kereskedhető státusz esetén nincs order", () => {
    const r = checkOrder(
      { symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", qty: "0.001", price: "60000", nowMs: NOW },
      { ...btc, status: "BREAK" },
    );
    expect(r.reason).toBe("not_trading");
  });

  it("ELAVULT szűrőkészlettel nem küldünk ordert", () => {
    expect(isStale(btc, NOW + 25 * 3600_000)).toBe(true);
    const r = checkOrder(
      { symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", qty: "0.001", price: "60000", nowMs: NOW + 25 * 3600_000 },
      btc,
    );
    expect(r.reason).toBe("stale_filters");
  });

  it("a kerekítés után nulla mennyiség külön ok", () => {
    const r = checkOrder({ symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", qty: "0", price: "60000", nowMs: NOW }, btc);
    expect(r.reason).toBe("zero_after_rounding");
  });
});

describe("sizeBuy / sizeSell — 100 USD tőke, mikroorder és dust", () => {
  it("100 USD tőkén a 2%-os DCA (2 USD) a minimum notional ALATT van", () => {
    const sized = sizeBuy("2", "60000", btc, NOW);
    expect(sized.check.ok).toBe(false);
    expect(sized.check.reason).toBe("below_min_notional");
  });

  it("10 USD keretből érvényes order lesz, a kerekítés utáni valós költéssel", () => {
    const sized = sizeBuy("10", "60000", btc, NOW);
    expect(sized.check.ok).toBe(true);
    expect(sized.qty).toBe("0.00016");
    expect(sized.notional).toBe("9.6");
    // A kerekítés miatt KEVESEBBET költünk, mint a keret — sosem többet.
    expect(Number(sized.notional)).toBeLessThanOrEqual(10);
  });

  it("dust eladása elutasításra kerül", () => {
    const sized = sizeSell("0.000001", "60000", btc, NOW);
    expect(sized.qty).toBe("0");
    expect(sized.check.ok).toBe(false);
  });

  it("a birtokolt mennyiség lefelé kerekül, nem felfelé", () => {
    const sized = sizeSell("0.000199999", "60000", btc, NOW);
    expect(sized.qty).toBe("0.00019");
    expect(Number(sized.qty)).toBeLessThanOrEqual(0.000199999);
  });

  it("határpont: pontosan a minimum notional átmegy", () => {
    // 5 USD / 60000 = 0.00008333 → lefelé 0.00008 → 4.8 USD, ami MÁR kevés.
    const justUnder = sizeBuy("5", "60000", btc, NOW);
    expect(justUnder.check.ok).toBe(false);
    // 5.4 USD-ből 0.00009 → 5.4 USD notional, ami elég.
    const justOver = sizeBuy("5.4", "60000", btc, NOW);
    expect(justOver.check.ok).toBe(true);
  });

  it("ár nélkül nincs méretezés", () => {
    expect(sizeBuy("100", "0", btc, NOW).check.ok).toBe(false);
    expect(sizeSell("1", "0", btc, NOW).check.ok).toBe(false);
  });
});

describe("protectionPrices — a védőorder árai is a szűrőkre kerülnek", () => {
  it("a stop és a limit is tickSize-ra kerekül, a limit a stop ALATT marad", () => {
    const { stop, limit } = protectionPrices("57123.456789", btc);
    expect(stop).toBe("57123.45");
    expect(Number(limit)).toBeLessThan(Number(stop));
    expect(limit).toBe(roundPrice(limit, btc));
  });

  it("nagyon durva tickSize mellett sem esik egybe a kettő", () => {
    const coarse: SymbolFilters = { ...btc, tickSize: "100" };
    const { stop, limit } = protectionPrices("57150", coarse, "0.0001");
    expect(Number(limit)).toBeLessThan(Number(stop));
  });
});

describe("fetchSymbolFilters — hiba esetén NINCS kitalált szabály", () => {
  it("sikeres válaszból szűrőkészlet lesz", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => exchangeInfoPayload }) as unknown as Response);
    const r = await fetchSymbolFilters([pairFor("BTC")], { now: () => NOW, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.error).toBeNull();
    expect(r.filters.BTCUSDT.tickSize).toBe("0.01");
  });

  it("HTTP hiba esetén ÜRES készlet és strukturált hiba", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response);
    const r = await fetchSymbolFilters(["BTCUSDT"], { now: () => NOW, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.filters).toEqual({});
    expect(r.error?.code).toBe("http_error");
  });

  it("hálózati hiba esetén sem találunk ki szabályt", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const r = await fetchSymbolFilters(["BTCUSDT"], { now: () => NOW, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.filters).toEqual({});
    expect(r.error?.code).toBe("network");
  });
});

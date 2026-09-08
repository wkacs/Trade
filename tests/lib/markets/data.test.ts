import { describe, it, expect } from "vitest";
import { fetchInstrumentCandles, fetchActiveCandles, timeframeFor, detectPriceAnomaly } from "@/lib/markets/data";
import type { OhlcvCandle } from "@/lib/market/candles";
import { findInstrument } from "@/lib/markets/registry";

const BTC = findInstrument("BTC")!;
const AAPL = findInstrument("AAPL")!;

const AFTER = Date.parse("2026-02-01T12:00:00Z"); // januári napi gyertyák lezártak

// Egy múltbeli órás Binance-gyertya (closeTime a múltban).
const H = 60 * 60 * 1000;
const t0 = Date.parse("2026-01-05T10:00:00Z");
const binanceRow = (openTime: number) => [
  openTime, "100", "110", "95", "108", "5", openTime + H - 1, "540", 12, "3", "320", "0",
];

// Yahoo napi chart-JSON: a bar időbélyege a nyitó pillanat (09:30 ET).
const YAHOO_JSON = {
  chart: {
    result: [
      {
        timestamp: [Date.parse("2026-01-02T14:30:00Z") / 1000],
        indicators: { quote: [{ open: [100], high: [105], low: [99], close: [104], volume: [1000] }] },
      },
    ],
    error: null,
  },
};

describe("markets/data", () => {
  it("timeframeFor: kripto 1h, részvény 1d", () => {
    expect(timeframeFor("crypto")).toBe("1h");
    expect(timeframeFor("stock")).toBe("1d");
  });

  it("kripto instrumentumot a Binance klines-útra irányít (USDT-pár)", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = (async (url: string) => {
      seenUrls.push(String(url));
      return { ok: true, status: 200, json: async () => [binanceRow(t0 - H), binanceRow(t0 - 2 * H)] };
    }) as unknown as typeof fetch;

    const res = await fetchInstrumentCandles(BTC, 1, { now: () => t0 + H, fetchImpl });
    expect(res.timeframe).toBe("1h");
    expect(res.error).toBeNull();
    expect(res.candles.length).toBeGreaterThan(0);
    expect(seenUrls[0]).toContain("symbol=BTCUSDT");
  });

  it("részvény instrumentumot a Yahoo napi chart-útra irányít", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = (async (url: string) => {
      seenUrls.push(String(url));
      return { ok: true, status: 200, json: async () => YAHOO_JSON };
    }) as unknown as typeof fetch;
    const res = await fetchInstrumentCandles(AAPL, 5, { now: () => AFTER, fetchImpl });
    expect(res.timeframe).toBe("1d");
    expect(res.error).toBeNull();
    expect(res.candles).toHaveLength(1);
    expect(res.candles[0].symbol).toBe("AAPL");
    expect(seenUrls[0]).toContain("/v8/finance/chart/AAPL");
  });

  it("a strukturált hibát továbbadja (nem dob)", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await fetchInstrumentCandles(AAPL, 5, { now: () => AFTER, fetchImpl });
    expect(res.candles).toEqual([]);
    expect(res.error?.code).toBe("http_error");
  });

  it("fetchActiveCandles alapból csak a kripto-kosarat tölti", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("binance")) {
        return { ok: true, status: 200, json: async () => [binanceRow(t0 - H)] };
      }
      return { ok: true, status: 200, json: async () => YAHOO_JSON };
    }) as unknown as typeof fetch;

    const results = await fetchActiveCandles(1, { now: () => t0 + H, fetchImpl, env: {} });
    expect(results.map((r) => r.instrument.symbol)).toEqual(["BTC", "ETH", "SOL"]);
    expect(results.every((r) => r.instrument.assetClass === "crypto")).toBe(true);
  });

  it("fetchActiveCandles részvényt is tölt, ha be van kapcsolva", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("binance")) {
        return { ok: true, status: 200, json: async () => [binanceRow(t0 - H)] };
      }
      return { ok: true, status: 200, json: async () => YAHOO_JSON };
    }) as unknown as typeof fetch;

    const results = await fetchActiveCandles(1, { now: () => AFTER, fetchImpl, env: { MARKETS_ENABLE_STOCKS: "1" } });
    const symbols = results.map((r) => r.instrument.symbol);
    expect(symbols).toContain("AAPL");
    const aapl = results.find((r) => r.instrument.symbol === "AAPL")!;
    expect(aapl.timeframe).toBe("1d");
  });
});

describe("markets/data – gyanús ár-sorozat (fail-closed)", () => {
  const bar = (openTime: number, close: number): OhlcvCandle => ({
    symbol: "AAPL",
    timeframe: "5m",
    openTime,
    closeTime: openTime + 300000,
    open: close,
    high: close,
    low: close,
    close,
    baseVolume: 1,
    quoteVolume: close,
    trades: 1,
    receivedAt: openTime,
  });

  it("normál sorozaton nincs riasztás", () => {
    const c = [bar(0, 100), bar(300000, 101), bar(600000, 99.5)];
    expect(detectPriceAnomaly(c, "5m")).toBeNull();
  });

  it("intraday 20% fölötti ugrást megjelöl", () => {
    const c = [bar(0, 100), bar(300000, 130)];
    expect(detectPriceAnomaly(c, "5m")).toMatchObject({ index: 1, from: 100, to: 130 });
  });

  it("napi baron a 30% még belefér (gyorsjelentés), a 60% nem", () => {
    const c = [bar(0, 100), bar(300000, 70)];
    expect(detectPriceAnomaly(c, "1d")).toBeNull();
    expect(detectPriceAnomaly([bar(0, 100), bar(300000, 40)], "1d")).not.toBeNull();
  });

  it("gyanús sorozatnál a lekérés ÜRES gyertyákat és strukturált hibát ad", async () => {
    const split = {
      chart: {
        result: [
          {
            timestamp: [Date.parse("2026-01-02T14:30:00Z") / 1000, Date.parse("2026-01-02T14:35:00Z") / 1000],
            indicators: { quote: [{ open: [1000, 100], high: [1000, 100], low: [1000, 100], close: [1000, 100], volume: [1, 1] }] },
          },
        ],
        error: null,
      },
    };
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => split })) as unknown as typeof fetch;
    const res = await fetchInstrumentCandles(AAPL, 5, { now: () => AFTER, fetchImpl, timeframe: "5m" });
    expect(res.candles).toEqual([]);
    expect(res.error?.code).toBe("suspect_series");
  });
});

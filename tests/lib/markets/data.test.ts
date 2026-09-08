import { describe, it, expect } from "vitest";
import { fetchInstrumentCandles, fetchActiveCandles, timeframeFor } from "@/lib/markets/data";
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

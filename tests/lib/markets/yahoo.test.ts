import { describe, it, expect, vi } from "vitest";
import {
  normalizeYahooDaily,
  fetchYahooDailyCandles,
  rangeForBars,
  type YahooChartPayload,
} from "@/lib/markets/yahoo";

// Jóval a januári dátumok után → minden januári sor LEZÁRT.
const AFTER = Date.parse("2026-02-01T12:00:00Z");
const DURING_SESSION = Date.parse("2026-01-05T15:00:00Z"); // hétfő 10:00 ET
const AFTER_HOURS = Date.parse("2026-01-05T22:00:00Z"); // hétfő 17:00 ET

/** A Yahoo napi bar időbélyege a nyitó pillanat (09:30 ET = 14:30 UTC télen). */
const ts = (isoDate: string) => Date.parse(`${isoDate}T14:30:00Z`) / 1000;

const PAYLOAD: YahooChartPayload = {
  chart: {
    result: [
      {
        timestamp: [ts("2026-01-02"), ts("2026-01-05")],
        indicators: {
          quote: [
            {
              open: [100, 104],
              high: [105, 110],
              low: [99, 103],
              close: [104, 108],
              volume: [1000, 1500],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

describe("markets/yahoo – normalizeYahooDaily", () => {
  it("érvényes chart-JSON-t OhlcvCandle-re normalizál, idő szerint rendezve", () => {
    const { candles, dropped } = normalizeYahooDaily(PAYLOAD, "AAPL", AFTER);
    expect(dropped).toEqual([]);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({
      symbol: "AAPL",
      timeframe: "1d",
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      baseVolume: 1000,
    });
    expect(candles[0].quoteVolume).toBe(1000 * 104);
    expect(candles[0].openTime).toBeLessThan(candles[1].openTime);
    // A záró bélyeg a nyitó + egy ülés, tehát MÚLTBELI a lezárt barnál.
    expect(candles[1].closeTime).toBeLessThan(AFTER);
  });

  it("a ma még formálódó gyertyát kihagyja (unclosed), zárás után beveszi", () => {
    const during = normalizeYahooDaily(PAYLOAD, "AAPL", DURING_SESSION);
    expect(during.candles.map((c) => c.close)).toEqual([104]); // csak jan 2
    expect(during.dropped).toContainEqual({ reason: "unclosed", dateKey: "2026-01-05" });

    const after = normalizeYahooDaily(PAYLOAD, "AAPL", AFTER_HOURS);
    expect(after.candles.map((c) => c.close)).toEqual([104, 108]);
  });

  it("null értéket és érvénytelen OHLC-t eldob", () => {
    const bad: YahooChartPayload = {
      chart: {
        result: [
          {
            timestamp: [ts("2026-01-02"), ts("2026-01-05")],
            indicators: {
              quote: [
                {
                  open: [100, null],
                  high: [90, null], // high < low
                  low: [99, null],
                  close: [104, null],
                  volume: [1000, null],
                },
              ],
            },
          },
        ],
      },
    };
    const { candles, dropped } = normalizeYahooDaily(bad, "AAPL", AFTER);
    expect(candles).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual(["invalid_ohlc", "invalid_ohlc"]);
  });

  it("hiányzó quote-tömb esetén üres, nem dob", () => {
    expect(normalizeYahooDaily({ chart: { result: [] } }, "AAPL", AFTER).candles).toEqual([]);
    expect(normalizeYahooDaily({}, "AAPL", AFTER).candles).toEqual([]);
  });
});

describe("markets/yahoo – rangeForBars", () => {
  it("a kért bar-számhoz elegendő range-et választ", () => {
    expect(rangeForBars(10)).toBe("1mo");
    expect(rangeForBars(90)).toBe("6mo");
    expect(rangeForBars(200)).toBe("1y");
    expect(rangeForBars(400)).toBe("2y");
  });
});

describe("markets/yahoo – fetchYahooDailyCandles", () => {
  it("a chart-végpontot hívja és a legutolsó N barral tér vissza", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => PAYLOAD,
    })) as unknown as typeof fetch;

    const res = await fetchYahooDailyCandles("AAPL", "AAPL", 1, { now: () => AFTER, fetchImpl });
    expect(res.error).toBeNull();
    expect(res.candles).toHaveLength(1);
    expect(res.candles[0].close).toBe(108);
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/v8/finance/chart/AAPL");
    expect(url).toContain("interval=1d");
  });

  it("HTTP-hibát STRUKTURÁLTAN ad vissza (nem néma üres sorozat)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await fetchYahooDailyCandles("AAPL", "AAPL", 5, { now: () => AFTER, fetchImpl });
    expect(res.candles).toEqual([]);
    expect(res.error).toMatchObject({ code: "http_error" });
    expect(res.error?.message).toContain("429");
  });

  it("a Yahoo saját hibaüzenetét is hibaként jelenti", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }),
    })) as unknown as typeof fetch;
    const res = await fetchYahooDailyCandles("ZZZZ", "ZZZZ", 5, { now: () => AFTER, fetchImpl });
    expect(res.error).toMatchObject({ code: "bad_payload" });
    expect(res.error?.message).toContain("Not Found");
  });

  it("hálózati kivételt elkap", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const res = await fetchYahooDailyCandles("AAPL", "AAPL", 5, { now: () => AFTER, fetchImpl });
    expect(res.error).toMatchObject({ code: "network" });
  });
});

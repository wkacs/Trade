import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeStooqDaily,
  isDailyBarClosed,
  fetchStooqDailyCandles,
} from "@/lib/markets/stooq";

// Jóval a januári dátumok után → minden januári sor LEZÁRT.
const AFTER = Date.parse("2026-02-01T12:00:00Z");
const DURING_SESSION = Date.parse("2026-01-05T15:00:00Z"); // hétfő 10:00 ET
const AFTER_HOURS = Date.parse("2026-01-05T22:00:00Z"); // hétfő 17:00 ET

const CSV = [
  "Date,Open,High,Low,Close,Volume",
  "2026-01-02,100,105,99,104,1000",
  "2026-01-05,104,110,103,108,1500",
].join("\n");

describe("markets/stooq – isDailyBarClosed", () => {
  it("múltbeli nap lezárt, jövőbeli nap future", () => {
    expect(isDailyBarClosed("2026-01-02", AFTER)).toBe("closed");
    expect(isDailyBarClosed("2026-03-01", AFTER)).toBe("future");
  });

  it("a mai gyertya ülés közben unclosed, zárás után closed", () => {
    expect(isDailyBarClosed("2026-01-05", DURING_SESSION)).toBe("unclosed");
    expect(isDailyBarClosed("2026-01-05", AFTER_HOURS)).toBe("closed");
  });
});

describe("markets/stooq – normalizeStooqDaily", () => {
  it("érvényes CSV-t OhlcvCandle-re normalizál, idő szerint rendezve", () => {
    const { candles, dropped } = normalizeStooqDaily(CSV, "AAPL", AFTER);
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
  });

  it("a ma még formálódó gyertyát kihagyja (unclosed), a régit megtartja", () => {
    const { candles, dropped } = normalizeStooqDaily(CSV, "AAPL", DURING_SESSION);
    expect(candles.map((c) => c.close)).toEqual([104]); // csak jan 2
    expect(dropped).toContainEqual({ reason: "unclosed", dateKey: "2026-01-05" });
  });

  it("érvénytelen OHLC-t és N/D értéket eldob", () => {
    const bad = [
      "Date,Open,High,Low,Close,Volume",
      "2026-01-02,100,90,99,104,1000", // high < low
      "2026-01-05,N/D,N/D,N/D,N/D,N/D", // hiányzó
    ].join("\n");
    const { candles, dropped } = normalizeStooqDaily(bad, "MSFT", AFTER);
    expect(candles).toHaveLength(0);
    expect(dropped.every((d) => d.reason === "invalid_ohlc")).toBe(true);
  });

  it("duplikált dátumot egyszer számol", () => {
    const dup = [
      "Date,Open,High,Low,Close,Volume",
      "2026-01-02,100,105,99,104,1000",
      "2026-01-02,101,106,100,105,1200",
    ].join("\n");
    const { candles, dropped } = normalizeStooqDaily(dup, "NVDA", AFTER);
    expect(candles).toHaveLength(1);
    expect(dropped).toContainEqual({ reason: "duplicate", dateKey: "2026-01-02" });
  });
});

describe("markets/stooq – fetchStooqDailyCandles", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("CSV választ normalizál és az utolsó `bars` gyertyát adja", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, text: async () => CSV });
    const { candles, error } = await fetchStooqDailyCandles("aapl.us", "AAPL", 1, { now: () => AFTER });
    expect(error).toBeNull();
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(108); // az utolsó (jan 5)
  });

  it("nem-CSV választ strukturált hibaként ad vissza (nem dob)", async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, text: async () => "No data" });
    const { candles, error } = await fetchStooqDailyCandles("zzz.us", "ZZZ", 5, { now: () => AFTER });
    expect(candles).toEqual([]);
    expect(error?.code).toBe("bad_payload");
  });

  it("HTTP hibát strukturáltan jelez", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 503, text: async () => "" });
    const { error } = await fetchStooqDailyCandles("aapl.us", "AAPL", 5, { now: () => AFTER });
    expect(error?.code).toBe("http_error");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BinanceOHLCCollector, candlesFromDataPoints } from "@/lib/collectors/binance";
import { normalizeBinanceKlines, findGaps, assessHistory, requiredBars, mergeCandles } from "@/lib/market/candles";

const HOUR = 3600_000;
/** 2026-09-05 12:00 UTC */
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

/** Egy Binance kline sor: [openTime, o, h, l, c, baseVol, closeTime, quoteVol, trades, …] */
const kline = (openTime: number, o: number, h: number, l: number, c: number, baseVol = 10, quoteVol = 1000) => [
  openTime,
  String(o),
  String(h),
  String(l),
  String(c),
  String(baseVol),
  openTime + HOUR - 1,
  String(quoteVol),
  25,
];

describe("normalizeBinanceKlines — csak lezárt gyertya", () => {
  it("AUDIT §5: a FUTÓ gyertya kiesik, a jövőbeli záró idő nem lesz „legfrissebb ár\"", () => {
    const closed = kline(NOW - 2 * HOUR, 100, 110, 95, 108);
    const running = kline(NOW - 1, 108, 120, 107, 115); // closeTime a JÖVŐBEN
    const r = normalizeBinanceKlines([closed, running], "BTC", "1h", NOW);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0].closeTime).toBeLessThanOrEqual(NOW);
    expect(r.dropped).toContainEqual({ reason: "unclosed", openTime: NOW - 1 });
  });

  it("megőrzi a valódi high/low-t, és a base- és quote-volument KÜLÖN", () => {
    const r = normalizeBinanceKlines([kline(NOW - 2 * HOUR, 100, 110, 95, 108, 12.5, 1300)], "BTC", "1h", NOW);
    const c = r.candles[0];
    expect({ open: c.open, high: c.high, low: c.low, close: c.close }).toEqual({
      open: 100,
      high: 110,
      low: 95,
      close: 108,
    });
    expect(c.baseVolume).toBe(12.5);
    expect(c.quoteVolume).toBe(1300);
    expect(c.trades).toBe(25);
  });

  it("kiszűri a jövőbeli nyitóidőt és a hibás OHLC-t", () => {
    const future = kline(NOW + HOUR, 100, 110, 95, 108);
    const broken = kline(NOW - 3 * HOUR, 100, 90, 95, 108); // high < low
    const negative = kline(NOW - 4 * HOUR, -1, 110, 95, 108);
    const r = normalizeBinanceKlines([future, broken, negative], "BTC", "1h", NOW);
    expect(r.candles).toHaveLength(0);
    expect(r.dropped.map((d) => d.reason).sort()).toEqual(["future", "invalid_ohlc", "invalid_ohlc"]);
  });

  it("a lapozási duplikációt kiszűri", () => {
    const a = kline(NOW - 2 * HOUR, 100, 110, 95, 108);
    const r = normalizeBinanceKlines([a, a], "BTC", "1h", NOW);
    expect(r.candles).toHaveLength(1);
    expect(r.dropped).toContainEqual({ reason: "duplicate", openTime: NOW - 2 * HOUR });
  });

  it("idő szerint rendez", () => {
    const r = normalizeBinanceKlines(
      [kline(NOW - 2 * HOUR, 1, 2, 0.5, 1.5), kline(NOW - 5 * HOUR, 1, 2, 0.5, 1.5)],
      "BTC",
      "1h",
      NOW,
    );
    expect(r.candles.map((c) => c.openTime)).toEqual([NOW - 5 * HOUR, NOW - 2 * HOUR]);
  });

  it("mergeCandles több lapból egyesít, duplikátum nélkül", () => {
    const p1 = normalizeBinanceKlines([kline(NOW - 3 * HOUR, 1, 2, 0.5, 1.5)], "BTC", "1h", NOW).candles;
    const p2 = normalizeBinanceKlines(
      [kline(NOW - 3 * HOUR, 1, 2, 0.5, 1.5), kline(NOW - 4 * HOUR, 1, 2, 0.5, 1.5)],
      "BTC",
      "1h",
      NOW,
    ).candles;
    expect(mergeCandles([p1, p2]).map((c) => c.openTime)).toEqual([NOW - 4 * HOUR, NOW - 3 * HOUR]);
  });
});

describe("rés- és visszatekintés-felismerés", () => {
  const series = (offsets: number[]) =>
    normalizeBinanceKlines(
      offsets.map((o) => kline(NOW - o * HOUR, 100, 110, 95, 108)),
      "BTC",
      "1h",
      NOW,
    ).candles;

  it("a rés felismert, nem tűnik el csendben", () => {
    const gaps = findGaps(series([5, 4, 2, 1]), "1h");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missing).toBe(1);
  });

  it("AUDIT §6: 24 gyertya nem elég a 48 órás momentum-ablakhoz", () => {
    const needed = requiredBars([24, 48], 0);
    expect(needed).toBe(48);
    const q = assessHistory(
      series(Array.from({ length: 24 }, (_, i) => 24 - i)),
      "1h",
      needed,
    );
    expect(q.count).toBe(24);
    expect(q.sufficient).toBe(false);
  });

  it("elég HÉZAGMENTES gyertya a sorozat VÉGÉN → elegendő", () => {
    const q = assessHistory(
      series(Array.from({ length: 60 }, (_, i) => 60 - i)),
      "1h",
      48,
    );
    expect(q.sufficient).toBe(true);
    expect(q.contiguousTail).toBe(60);
  });

  it("a végén lévő RÉS miatt nem elegendő, hiába sok a gyertya összesen", () => {
    // 60 gyertya, de az utolsó 10 előtt hiányzik egy.
    const offsets = [...Array.from({ length: 50 }, (_, i) => 61 - i), ...Array.from({ length: 10 }, (_, i) => 10 - i)];
    const q = assessHistory(series(offsets), "1h", 48);
    expect(q.count).toBe(60);
    expect(q.sufficient).toBe(false);
    expect(q.contiguousTail).toBe(10);
  });

  it("a warmup hozzáadódik a szükséges mennyiséghez", () => {
    expect(requiredBars([24, 48], 14)).toBe(62);
    expect(requiredBars([], 5)).toBe(5);
  });
});

describe("BinanceOHLCCollector", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("klines gyertyákat price DataPoint-tá alakít, teljes OHLCV-vel", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [kline(NOW - 2 * HOUR, 100, 110, 95, 108), kline(NOW - HOUR, 108, 120, 107, 115)],
    });
    const r = await new BinanceOHLCCollector(["BTC"], "1h", 2, { now: () => NOW }).collect();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ source: "binance", symbol: "BTC", kind: "price" });
    expect(r[0].price?.usd).toBe(108);
    // A timestamp a MÚLTBELI záró idő, nem jövőbeli.
    expect(r[0].timestamp).toBeLessThanOrEqual(NOW);
    expect(r[0].price?.change24hPct).toBeCloseTo(8, 6);
    expect(r[0].ohlcv).toMatchObject({ open: 100, high: 110, low: 95, close: 108 });
  });

  it("rate limit esetén üres lista ÉS strukturált hiba (nem néma teljes adatsor)", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 429 });
    const collector = new BinanceOHLCCollector(["BTC"], "1h", 24, { now: () => NOW });
    const r = await collector.collect();
    expect(r).toEqual([]);
    expect(collector.lastResults.BTC.error?.code).toBe("rate_limited");
  });

  it("API hiba esetén üres listát ad (nem dob)", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 500 });
    const r = await new BinanceOHLCCollector(["BTC"], "1h", 24, { now: () => NOW }).collect();
    expect(r).toEqual([]);
  });

  it("a DataPoint-okból visszanyerhetők a gyertyák (valódi high/low az ATR-hez)", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [kline(NOW - 2 * HOUR, 100, 110, 95, 108)],
    });
    const events = await new BinanceOHLCCollector(["BTC"], "1h", 1, { now: () => NOW }).collect();
    const candles = candlesFromDataPoints(events, "BTC");
    expect(candles).toHaveLength(1);
    expect(candles[0].high).toBe(110);
    expect(candles[0].low).toBe(95);
  });
});

describe("BinanceOHLCCollector — a lekérés hibája nem tűnhet el", () => {
  it("lastError()-ben jelenti a HTTP hibát, nem csak a konzolra írja", async () => {
    const fetchImpl = (async () =>
      new Response("blocked", { status: 451, statusText: "Unavailable For Legal Reasons" })) as unknown as typeof fetch;
    const c = new BinanceOHLCCollector(["BTC"], "1h", 72, { now: () => NOW, fetchImpl });
    const points = await c.collect();
    expect(points).toHaveLength(0);
    expect(c.lastError()).toContain("451");
    expect(c.lastError()).toContain("BTC");
  });

  it("sikeres lekérés után nincs hiba", async () => {
    const rows = [kline(NOW - 2 * HOUR, 100, 110, 95, 108)];
    const fetchImpl = (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;
    const c = new BinanceOHLCCollector(["BTC"], "1h", 1, { now: () => NOW, fetchImpl });
    await c.collect();
    expect(c.lastError()).toBeNull();
  });
});

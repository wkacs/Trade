import type { Candle, HistoryFrame } from "./types";
import { normalizeBinanceKlines, mergeCandles, findGaps, TIMEFRAME_MS } from "@/lib/market/candles";

const HOUR = 3600_000;

/**
 * Time-aligned keretek a symbolonkénti gyertyákból + a Fear&Greed óra→érték map-ből.
 * Minden előforduló óra-timestamp egy frame. A F&G forward-fill: az adott órára a
 * legközelebbi NEM-jövőbeli ismert érték (a F&G napi, ezért óránként ismételjük). Tiszta.
 */
export function alignFrames(
  candlesBySymbol: Record<string, Candle[]>,
  fgByHour: Map<number, number>,
): HistoryFrame[] {
  // Az összes óra-timestamp összegyűjtése.
  const tsSet = new Set<number>();
  for (const arr of Object.values(candlesBySymbol)) for (const k of arr) tsSet.add(k.ts);
  const allTs = Array.from(tsSet).sort((a, b) => a - b);

  // F&G forward-fill: rendezett ismert pontok, minden óra a ≤ts utolsó értéket kapja.
  const fgPoints = Array.from(fgByHour.entries()).sort((a, b) => a[0] - b[0]);
  const fgAt = (ts: number): number | null => {
    let val: number | null = null;
    for (const [t, v] of fgPoints) {
      if (t <= ts) val = v;
      else break;
    }
    return val;
  };

  // Gyors lookup: symbol -> (ts -> candle).
  const idx: Record<string, Map<number, Candle>> = {};
  for (const [sym, arr] of Object.entries(candlesBySymbol)) {
    idx[sym] = new Map(arr.map((k) => [k.ts, k]));
  }

  return allTs.map((ts) => {
    const candles: Record<string, Candle> = {};
    for (const sym of Object.keys(candlesBySymbol)) {
      const k = idx[sym].get(ts);
      if (k) candles[sym] = k;
    }
    return { ts, candles, fearGreedValue: fgAt(ts) };
  });
}

export interface LoadQuality {
  bySymbol: Record<
    string,
    { bars: number; gaps: number; droppedUnclosed: number; droppedDuplicate: number; error: string | null }
  >;
  /** Igaz, ha BÁRMELYIK symbolnál hiba vagy rés volt — a riportban látszania kell. */
  degraded: boolean;
}

/**
 * Binance 1h klines egy symbolra. A T12 óta a NEM LEZÁRT gyertya kiesik, a lapozási
 * duplikátumot kiszűrjük, és a hiba nem néma: a hívó megkapja a minőségjelentést.
 */
async function fetchKlines(
  symbol: string,
  pages: number,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<{ candles: Candle[]; dropped: { unclosed: number; duplicate: number }; error: string | null }> {
  const collected: ReturnType<typeof normalizeBinanceKlines>["candles"][] = [];
  let unclosed = 0;
  let duplicate = 0;
  let error: string | null = null;
  let endTime: number | undefined;

  for (let p = 0; p < pages; p++) {
    const u = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=1000${
      endTime ? `&endTime=${endTime}` : ""
    }`;
    let rows: unknown[][];
    try {
      const res = await fetchImpl(u);
      if (res.status === 429 || res.status === 418) {
        error = `rate_limited (${res.status}) — az adatsor HIÁNYOS`;
        break;
      }
      if (!res.ok) {
        error = `HTTP ${res.status}`;
        break;
      }
      rows = (await res.json()) as unknown[][];
    } catch (e) {
      error = `network: ${String(e)}`;
      break;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    const norm = normalizeBinanceKlines(rows, symbol, "1h", nowMs);
    unclosed += norm.dropped.filter((d) => d.reason === "unclosed").length;
    duplicate += norm.dropped.filter((d) => d.reason === "duplicate").length;
    collected.push(norm.candles);
    endTime = Number(rows[0][0]) - 1; // a következő lap a régebbi adat
  }

  const merged = mergeCandles(collected);
  duplicate += collected.reduce((s, page) => s + page.length, 0) - merged.length;
  return {
    candles: merged.map((c) => ({
      ts: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.baseVolume,
    })),
    dropped: { unclosed, duplicate },
    error,
  };
}

/** Fear&Greed history (alternative.me) → óra-timestamp → érték (a nap kezdő órájára). */
async function fetchFearGreed(limit: number, fetchImpl: typeof fetch): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const res = await fetchImpl(`https://api.alternative.me/fng/?limit=${limit}&format=json`);
    if (!res.ok) return map;
    const body = (await res.json()) as { data?: { value: string; timestamp: string }[] };
    for (const d of body.data ?? []) {
      const ts = Number(d.timestamp) * 1000; // sec → ms (a nap kezdete UTC)
      const hourTs = Math.floor(ts / HOUR) * HOUR;
      map.set(hourTs, Number(d.value));
    }
  } catch (e) {
    console.error("[backtest/data] F&G fetch hiba:", e);
  }
  return map;
}

/**
 * Teljes történelmi adat: symbolonkénti klines + F&G, time-aligned keretekké.
 * @param pages 1000-es klines lapok száma symbolonként (5 ≈ 5000 óra ≈ 208 nap).
 */
export async function loadHistory(
  symbols: string[],
  pages = 5,
  opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<{ frames: HistoryFrame[]; quality: LoadQuality }> {
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const candlesBySymbol: Record<string, Candle[]> = {};
  const quality: LoadQuality = { bySymbol: {}, degraded: false };

  for (const sym of symbols) {
    const r = await fetchKlines(sym, pages, now(), fetchImpl);
    candlesBySymbol[sym] = r.candles;
    const gaps = findGaps(
      r.candles.map((c) => ({
        symbol: sym,
        timeframe: "1h" as const,
        openTime: c.ts,
        closeTime: c.ts + TIMEFRAME_MS["1h"] - 1,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        baseVolume: c.volume,
        quoteVolume: 0,
        trades: 0,
        receivedAt: now(),
      })),
      "1h",
    );
    quality.bySymbol[sym] = {
      bars: r.candles.length,
      gaps: gaps.length,
      droppedUnclosed: r.dropped.unclosed,
      droppedDuplicate: r.dropped.duplicate,
      error: r.error,
    };
    if (r.error || gaps.length > 0) quality.degraded = true;
  }

  const fgDays = Math.ceil((pages * 1000) / 24) + 10;
  const fg = await fetchFearGreed(fgDays, fetchImpl);
  return { frames: alignFrames(candlesBySymbol, fg), quality };
}

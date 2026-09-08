/**
 * Yahoo Finance napi OHLCV provider — ingyenes, KULCS NÉLKÜLI részvényadat.
 *
 * Miért ő és nem a Stooq: 2026-09-08-tól a Stooq CSV-végpontja JS-alapú
 * bot-ellenőrzés (proof-of-work challenge) mögé került, és kulcs nélküli HTTP-ből
 * HTML-t ad CSV helyett. A Yahoo `chart` végpontja ugyanezt a napi OHLCV-t adja
 * JSON-ban, kulcs és süti nélkül:
 *
 *   https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=6mo&interval=1d
 *
 * Ugyanaz a fegyelem, mint a Binance- és a Stooq-úton: CSAK LEZÁRT gyertya kerül be.
 * Egy napi gyertya akkor lezárt, ha a dátuma korábbi az aktuális ET-napnál, VAGY ma van
 * és a szabályos ülés MÁR VÉGET ÉRT (after-hours) — a naptár dönt, nem kézi DST-számolás.
 *
 * Tiszta normalizáló + külön hálózati lekérés (az idő injektált, nincs rejtett IO).
 */

import type { OhlcvCandle, Timeframe } from "@/lib/market/candles";
import { etParts, etDateKey, isDailyBarClosed } from "./calendar";

const YAHOO_TF: Timeframe = "1d";
/** A szabályos ülés hossza (09:30–16:00 ET) — a napi bar záró bélyege az openTime-ból. */
const SESSION_LENGTH_MS = 6.5 * 60 * 60 * 1000;

export interface YahooNormalizeResult {
  candles: OhlcvCandle[];
  /** Miért esett ki egy sor — látható diagnosztika a néma adatvesztés helyett. */
  dropped: { reason: "unclosed" | "future" | "invalid_ohlc" | "duplicate" | "malformed"; dateKey: string }[];
}

/** A Yahoo `chart` válasz minimálisan szükséges alakja (a többi mezőt nem használjuk). */
export interface YahooChartPayload {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators?: {
        quote?: {
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }[];
      };
    }[];
    error?: { code?: string; description?: string } | null;
  };
}

/**
 * Yahoo chart-JSON normalizálása `OhlcvCandle[]`-re.
 *
 * @param payload  a nyers JSON (már parse-olva)
 * @param symbol   a belső szimbólum (pl. "AAPL")
 * @param nowMs    az aktuális idő (lezártság-döntéshez)
 * @param receivedAt adatfrissesség-bélyeg (alap: nowMs)
 */
export function normalizeYahooDaily(
  payload: YahooChartPayload,
  symbol: string,
  nowMs: number,
  receivedAt: number = nowMs,
): YahooNormalizeResult {
  const dropped: YahooNormalizeResult["dropped"] = [];
  const seen = new Set<string>();
  const candles: OhlcvCandle[] = [];

  const result = payload.chart?.result?.[0];
  const stamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote) return { candles, dropped };

  for (let i = 0; i < stamps.length; i++) {
    const ts = stamps[i];
    if (!Number.isFinite(ts)) {
      dropped.push({ reason: "malformed", dateKey: String(ts) });
      continue;
    }
    const openTime = ts * 1000;
    // A napi bar ET-dátuma a nyitó pillanatból (09:30 ET) — a naptár DST-t is kezel.
    const dateKey = etDateKey(etParts(openTime));

    const closed = isDailyBarClosed(dateKey, nowMs);
    if (closed === "future") {
      dropped.push({ reason: "future", dateKey });
      continue;
    }
    if (closed === "unclosed") {
      dropped.push({ reason: "unclosed", dateKey });
      continue;
    }

    // A Yahoo a hiányzó értéket `null`-lal jelöli (pl. fél-nap, adathiba) — az kiesik.
    const open = Number(quote.open?.[i]);
    const high = Number(quote.high?.[i]);
    const low = Number(quote.low?.[i]);
    const close = Number(quote.close?.[i]);
    const rawVolume = Number(quote.volume?.[i]);
    const volume = Number.isFinite(rawVolume) ? rawVolume : 0;

    const ohlcOk =
      quote.open?.[i] != null &&
      quote.high?.[i] != null &&
      quote.low?.[i] != null &&
      quote.close?.[i] != null &&
      [open, high, low, close].every((v) => Number.isFinite(v) && v > 0) &&
      high >= low &&
      high >= open &&
      high >= close &&
      low <= open &&
      low <= close;
    if (!ohlcOk) {
      dropped.push({ reason: "invalid_ohlc", dateKey });
      continue;
    }
    if (seen.has(dateKey)) {
      dropped.push({ reason: "duplicate", dateKey });
      continue;
    }
    seen.add(dateKey);

    candles.push({
      symbol,
      timeframe: YAHOO_TF,
      openTime,
      closeTime: openTime + SESSION_LENGTH_MS,
      open,
      high,
      low,
      close,
      // Részvénynél nincs base/quote megkülönböztetés; a darabszám a base-volume,
      // a quote-volume ~ close*volume (közelítő forgalom, nem tőzsdei mérőszám).
      baseVolume: volume,
      quoteVolume: volume * close,
      trades: 0,
      receivedAt,
    });
  }

  candles.sort((a, b) => a.openTime - b.openTime);
  return { candles, dropped };
}

export interface YahooFetchResult {
  candles: OhlcvCandle[];
  error: { code: "http_error" | "network" | "bad_payload"; message: string } | null;
}

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
/** A Yahoo kulcs nélkül is válaszol, de böngésző-UA nélkül gyakrabban dob 429-et. */
const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** A kért bar-számhoz elegendő, de nem pazarló `range` paraméter. */
export function rangeForBars(bars: number): string {
  if (bars <= 20) return "1mo";
  if (bars <= 60) return "3mo";
  if (bars <= 120) return "6mo";
  if (bars <= 250) return "1y";
  return "2y";
}

/**
 * Napi lezárt gyertyák lekérése a Yahoo-ról egy providerSymbol-ra (pl. "AAPL").
 * A hibát STRUKTURÁLTAN adja vissza — a hálózati hiba nem lesz csendben üres sorozat.
 */
export async function fetchYahooDailyCandles(
  providerSymbol: string,
  symbol: string,
  bars: number,
  opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<YahooFetchResult> {
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${YAHOO_BASE}${encodeURIComponent(providerSymbol)}?range=${rangeForBars(bars)}&interval=1d`;

  try {
    const res = await doFetch(url, { headers: { "User-Agent": YAHOO_UA, Accept: "application/json" } });
    if (!res.ok) {
      return { candles: [], error: { code: "http_error", message: `Yahoo HTTP ${res.status} (${providerSymbol})` } };
    }
    let payload: YahooChartPayload;
    try {
      payload = (await res.json()) as YahooChartPayload;
    } catch {
      return { candles: [], error: { code: "bad_payload", message: `Yahoo nem-JSON válasz (${providerSymbol})` } };
    }
    const apiError = payload.chart?.error;
    if (apiError) {
      return {
        candles: [],
        error: { code: "bad_payload", message: `Yahoo hiba (${providerSymbol}): ${apiError.code ?? "?"} ${apiError.description ?? ""}`.trim() },
      };
    }
    if (!payload.chart?.result?.[0]?.indicators?.quote?.[0]) {
      return { candles: [], error: { code: "bad_payload", message: `Yahoo üres chart-eredmény (${providerSymbol})` } };
    }
    const { candles } = normalizeYahooDaily(payload, symbol, now());
    return { candles: candles.slice(-bars), error: null };
  } catch (e) {
    return { candles: [], error: { code: "network", message: `Yahoo hálózati hiba (${providerSymbol}): ${String(e)}` } };
  }
}

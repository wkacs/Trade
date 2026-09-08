/**
 * Stooq napi OHLCV provider — ingyenes, KULCS NÉLKÜLI részvényadat.
 *
 * A Stooq CSV-t ad (`stooq.com/q/d/l/?s=aapl.us&i=d`), fejléc:
 *   Date,Open,High,Low,Close,Volume
 *
 * A részvény-ág NAPI gyertyán dönt (a kulcs nélküli intraday megbízhatatlan, és a napi
 * ritmus amúgy is illik a részvénypiachoz). Ugyanaz a fegyelem, mint a Binance-úton:
 * CSAK LEZÁRT gyertya kerül be. Egy napi gyertya akkor lezárt, ha a dátuma korábbi az
 * aktuális ET-napnál, VAGY ma van és a szabályos ülés MÁR VÉGET ÉRT (after-hours).
 * A ma még formálódó gyertya kiesik — a régi kripto-hiba (jövőbeli/nyitott gyertya
 * „aktuális árként") itt sem ismételhető meg.
 *
 * Tiszta normalizáló + külön hálózati lekérés (az idő injektált, nincs rejtett IO).
 */

import type { OhlcvCandle, Timeframe } from "@/lib/market/candles";
import { etParts, etDateKey, usEquitySession } from "./calendar";

const STOOQ_TF: Timeframe = "1d";

export interface StooqNormalizeResult {
  candles: OhlcvCandle[];
  /** Miért esett ki egy sor — látható diagnosztika a néma adatvesztés helyett. */
  dropped: { reason: "unclosed" | "future" | "invalid_ohlc" | "duplicate" | "malformed"; dateKey: string }[];
}

/**
 * Egy napi gyertya lezárt-e az adott ET-időben.
 *
 * A `closeTime` aritmetika helyett a NAPTÁRRA támaszkodunk: a napi bar záró pillanata
 * a szabályos ülés vége (16:00 ET), amit a kézi DST helyett a naptár dönt el.
 */
export function isDailyBarClosed(dateKey: string, nowMs: number): "closed" | "unclosed" | "future" {
  const todayKey = etDateKey(etParts(nowMs));
  if (dateKey < todayKey) return "closed";
  if (dateKey > todayKey) return "future";
  // Ma: csak akkor lezárt, ha az ülés véget ért.
  return usEquitySession(nowMs).reason === "after-hours" ? "closed" : "unclosed";
}

// A napi gyertya reprezentatív időbélyegei UTC-ben. NEM használjuk „árazásra"; a lezártságot
// a naptár dönti el (isDailyBarClosed). A ~13:30 / ~21:00 UTC az EDT-beli 09:30 / 16:00 ET-hez
// közelít — a modellezés a záróárat és a high/low-t használja, nem a bar percre pontos idejét.
function openTimeOf(dateKey: string): number {
  return Date.parse(`${dateKey}T13:30:00Z`);
}
function closeTimeOf(dateKey: string): number {
  return Date.parse(`${dateKey}T21:00:00Z`);
}

/**
 * Stooq napi CSV normalizálása `OhlcvCandle[]`-re.
 *
 * @param csv      a nyers CSV szöveg
 * @param symbol   a belső szimbólum (pl. "AAPL")
 * @param nowMs    az aktuális idő (lezártság-döntéshez)
 * @param receivedAt adatfrissesség-bélyeg (alap: nowMs)
 */
export function normalizeStooqDaily(
  csv: string,
  symbol: string,
  nowMs: number,
  receivedAt: number = nowMs,
): StooqNormalizeResult {
  const dropped: StooqNormalizeResult["dropped"] = [];
  const seen = new Set<string>();
  const candles: OhlcvCandle[] = [];

  const lines = csv.trim().split(/\r?\n/);
  // Az első sor a fejléc, ha "Date"-tel kezdődik.
  const start = lines.length > 0 && /^date,/i.test(lines[0]) ? 1 : 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 5) {
      dropped.push({ reason: "malformed", dateKey: cols[0] ?? "?" });
      continue;
    }
    const dateKey = cols[0];
    // Stooq a hiányzó értéket néha "N/D"-vel jelöli — ez nem szám, kiesik.
    const open = Number(cols[1]);
    const high = Number(cols[2]);
    const low = Number(cols[3]);
    const close = Number(cols[4]);
    const volume = cols.length >= 6 ? Number(cols[5]) : 0;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      dropped.push({ reason: "malformed", dateKey });
      continue;
    }

    const closed = isDailyBarClosed(dateKey, nowMs);
    if (closed === "future") {
      dropped.push({ reason: "future", dateKey });
      continue;
    }
    if (closed === "unclosed") {
      dropped.push({ reason: "unclosed", dateKey });
      continue;
    }

    const ohlcOk =
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
      timeframe: STOOQ_TF,
      openTime: openTimeOf(dateKey),
      closeTime: closeTimeOf(dateKey),
      open,
      high,
      low,
      close,
      // Részvénynél nincs base/quote megkülönböztetés; a darabszám a base-volume,
      // a quote-volume ~ close*volume (közelítő forgalom, nem tőzsdei mérőszám).
      baseVolume: Number.isFinite(volume) ? volume : 0,
      quoteVolume: Number.isFinite(volume) ? volume * close : 0,
      trades: 0,
      receivedAt,
    });
  }

  candles.sort((a, b) => a.openTime - b.openTime);
  return { candles, dropped };
}

export interface StooqFetchResult {
  candles: OhlcvCandle[];
  error: { code: "http_error" | "network" | "bad_payload"; message: string } | null;
}

const STOOQ_BASE = "https://stooq.com/q/d/l/";

/**
 * Napi lezárt gyertyák lekérése a Stooq-ról egy providerSymbol-ra (pl. "aapl.us").
 * A hibát STRUKTURÁLTAN adja vissza — a hálózati hiba nem lesz csendben üres sorozat.
 */
export async function fetchStooqDailyCandles(
  providerSymbol: string,
  symbol: string,
  bars: number,
  opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<StooqFetchResult> {
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${STOOQ_BASE}?s=${encodeURIComponent(providerSymbol)}&i=d`;

  try {
    const res = await doFetch(url);
    if (!res.ok) {
      return { candles: [], error: { code: "http_error", message: `Stooq HTTP ${res.status} (${providerSymbol})` } };
    }
    const text = await res.text();
    // Stooq üzenetei: "No data" / HTML — a CSV fejlécnek "Date"-tel kell kezdődnie.
    if (!/date,/i.test(text.slice(0, 64))) {
      return { candles: [], error: { code: "bad_payload", message: `Stooq nem-CSV válasz (${providerSymbol})` } };
    }
    const { candles } = normalizeStooqDaily(text, symbol, now());
    return { candles: candles.slice(-bars), error: null };
  } catch (e) {
    return { candles: [], error: { code: "network", message: `Stooq hálózati hiba (${providerSymbol}): ${String(e)}` } };
  }
}

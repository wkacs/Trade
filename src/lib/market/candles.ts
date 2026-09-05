/**
 * Lezárt, tőzsdei OHLCV (T12).
 *
 * Az audit §5 bizonyította: a régi collector 24 gyertyát kért, MEGTARTOTTA a még nem
 * lezárt gyertyát, és annak JÖVŐBELI zárási időpontját adta timestampnek. A tick a
 * legnagyobb timestampet választotta „aktuális árnak", vagyis egy jövőbeli időbélyeget.
 * A high/low elveszett (csak a close került be), így az ATR close-only lett.
 *
 * Itt a modellezéshez használt adat szabályai:
 *  - CSAK lezárt gyertya (closeTime <= now);
 *  - valódi open/high/low/close és külön base- ÉS quote-volume;
 *  - idő szerint rendezve, duplikátumok nélkül;
 *  - a rések FELISMERTEK, nem tűnnek el csendben;
 *  - a visszatekintés az IDŐKERETHEZ tartozik, nem puszta elemszámhoz.
 *
 * Tiszta függvények: az idő injektált, nincs IO. A hálózati lekérés lent, külön.
 */

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface OhlcvCandle {
  symbol: string;
  timeframe: Timeframe;
  /** A gyertya nyitó ideje (epoch ms). */
  openTime: number;
  /** A gyertya záró ideje (epoch ms) — MÚLTBELI, mert csak lezárt gyertyát tartunk meg. */
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Base eszközben mért mennyiség (pl. BTC). */
  baseVolume: number;
  /** Quote eszközben mért forgalom (pl. USDT) — NEM keverendő a base-zel. */
  quoteVolume: number;
  trades: number;
  /** Mikor észleltük (adatfrissesség-méréshez). */
  receivedAt: number;
}

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export interface NormalizeResult {
  candles: OhlcvCandle[];
  /** Miért esett ki egy sor — a néma adatvesztés helyett látható diagnosztika. */
  dropped: { reason: "unclosed" | "future" | "invalid_ohlc" | "duplicate"; openTime: number }[];
}

/** Igaz, ha a gyertya a megadott időben MÁR LEZÁRT. */
export function isClosed(closeTime: number, nowMs: number): boolean {
  return Number.isFinite(closeTime) && closeTime <= nowMs;
}

/**
 * Binance `/api/v3/klines` sorok normalizálása.
 *
 * A Binance sor: [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume,
 * trades, takerBuyBase, takerBuyQuote, ignore].
 */
export function normalizeBinanceKlines(
  rows: unknown[][],
  symbol: string,
  timeframe: Timeframe,
  nowMs: number,
  receivedAt: number = nowMs,
): NormalizeResult {
  const dropped: NormalizeResult["dropped"] = [];
  const seen = new Set<number>();
  const candles: OhlcvCandle[] = [];

  for (const row of rows) {
    const openTime = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const baseVolume = Number(row[5]);
    const closeTime = Number(row[6]);
    const quoteVolume = Number(row[7]);
    const trades = Number(row[8]);

    if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) {
      dropped.push({ reason: "invalid_ohlc", openTime });
      continue;
    }
    if (openTime > nowMs) {
      dropped.push({ reason: "future", openTime });
      continue;
    }
    if (!isClosed(closeTime, nowMs)) {
      // A FUTÓ gyertya kiesik: a záró ideje jövőbeli, az ára nem végleges.
      dropped.push({ reason: "unclosed", openTime });
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
      dropped.push({ reason: "invalid_ohlc", openTime });
      continue;
    }
    if (seen.has(openTime)) {
      // Lapozásból származó ismétlődés — a régi kód ezt csendben duplán számolta.
      dropped.push({ reason: "duplicate", openTime });
      continue;
    }
    seen.add(openTime);
    candles.push({
      symbol,
      timeframe,
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      baseVolume: Number.isFinite(baseVolume) ? baseVolume : 0,
      quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0,
      trades: Number.isFinite(trades) ? trades : 0,
      receivedAt,
    });
  }

  candles.sort((a, b) => a.openTime - b.openTime);
  return { candles, dropped };
}

/** Több lapból összeálló sorozat: rendezés + duplikátum-szűrés (a korábbi sor nyer). */
export function mergeCandles(pages: OhlcvCandle[][]): OhlcvCandle[] {
  const byTime = new Map<number, OhlcvCandle>();
  for (const page of pages) {
    for (const c of page) if (!byTime.has(c.openTime)) byTime.set(c.openTime, c);
  }
  return Array.from(byTime.values()).sort((a, b) => a.openTime - b.openTime);
}

export interface Gap {
  /** Az utolsó meglévő gyertya nyitó ideje a rés előtt. */
  afterOpenTime: number;
  /** A következő meglévő gyertya nyitó ideje a rés után. */
  beforeOpenTime: number;
  /** Hány gyertya hiányzik. */
  missing: number;
}

/** A sorozat réseinek felismerése. Réses adat NEM kap automatikus trendengedélyt. */
export function findGaps(candles: OhlcvCandle[], timeframe: Timeframe): Gap[] {
  const step = TIMEFRAME_MS[timeframe];
  const gaps: Gap[] = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].openTime - candles[i - 1].openTime;
    if (delta > step) {
      gaps.push({
        afterOpenTime: candles[i - 1].openTime,
        beforeOpenTime: candles[i].openTime,
        missing: Math.round(delta / step) - 1,
      });
    }
  }
  return gaps;
}

export interface HistoryQuality {
  count: number;
  gaps: Gap[];
  /** Igaz, ha van elég HÉZAGMENTES gyertya a sorozat VÉGÉN a szükséges visszatekintéshez. */
  sufficient: boolean;
  /** A sorozat végén lévő, hézagmentes gyertyák száma. */
  contiguousTail: number;
  /** A legutolsó gyertya záró ideje (adatfrissesség). */
  lastCloseTime: number | null;
}

/**
 * Adatminőség egy szükséges visszatekintéshez. A LÉNYEG: nem elég, hogy sok gyertya van
 * — a VÉGÉN kell legyen elég HÉZAGMENTES gyertya, különben a jel hiányos adatból születne.
 */
export function assessHistory(candles: OhlcvCandle[], timeframe: Timeframe, requiredBars: number): HistoryQuality {
  const step = TIMEFRAME_MS[timeframe];
  let contiguous = candles.length > 0 ? 1 : 0;
  for (let i = candles.length - 1; i > 0; i--) {
    if (candles[i].openTime - candles[i - 1].openTime === step) contiguous++;
    else break;
  }
  return {
    count: candles.length,
    gaps: findGaps(candles, timeframe),
    contiguousTail: contiguous,
    sufficient: contiguous >= requiredBars,
    lastCloseTime: candles.length > 0 ? candles[candles.length - 1].closeTime : null,
  };
}

/**
 * A szükséges gyertyaszám: a legnagyobb visszatekintés ÉS a bemelegítés együtt.
 * Az audit §6 példája: a momentum 48 órás ablakot kér, de a collector 24-et adott, ezért
 * egy végig emelkedő soron is `false` jött ki.
 */
export function requiredBars(lookbacks: number[], warmup = 0): number {
  const max = lookbacks.filter((n) => Number.isFinite(n) && n > 0).reduce((a, b) => Math.max(a, b), 0);
  return max + warmup;
}

// ── Hálózati lekérés ────────────────────────────────────────────────────────

export interface FetchResult {
  candles: OhlcvCandle[];
  quality: HistoryQuality;
  /** Strukturált hiba, ha a lekérés (részben) elbukott. A hiba NEM csendes üres sorozat. */
  error: { code: "http_error" | "rate_limited" | "network" | "bad_payload"; message: string } | null;
}

const BINANCE_BASE = "https://api.binance.com";

/**
 * Lezárt gyertyák lekérése a Binance-ról. Lapoz, amíg meg nem lesz a kért mennyiség.
 *
 * A hibát STRUKTURÁLTAN adja vissza: a hálózati hiba vagy a 429 rate limit NEM
 * eredményezhet csendben hiányos, de érvényesnek látszó adatsort.
 */
export async function fetchClosedCandles(
  symbol: string,
  timeframe: Timeframe,
  bars: number,
  opts: {
    now?: () => number;
    fetchImpl?: typeof fetch;
    quotePair?: string;
    maxPages?: number;
  } = {},
): Promise<FetchResult> {
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const pair = opts.quotePair ?? "USDT";
  const maxPages = opts.maxPages ?? 5;
  const pages: OhlcvCandle[][] = [];
  let error: FetchResult["error"] = null;
  let endTime: number | undefined;

  for (let page = 0; page < maxPages; page++) {
    const limit = Math.min(1000, Math.max(bars + 1, 2));
    const url =
      `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}${pair}&interval=${timeframe}&limit=${limit}` +
      (endTime ? `&endTime=${endTime}` : "");
    try {
      const res = await doFetch(url);
      if (res.status === 429 || res.status === 418) {
        error = { code: "rate_limited", message: `Binance rate limit (${res.status}) — az adatsor HIÁNYOS.` };
        break;
      }
      if (!res.ok) {
        error = { code: "http_error", message: `Binance HTTP ${res.status} (${symbol})` };
        break;
      }
      const rows = (await res.json()) as unknown[][];
      if (!Array.isArray(rows) || rows.length === 0) break;
      const { candles } = normalizeBinanceKlines(rows, symbol, timeframe, now());
      pages.push(candles);
      const merged = mergeCandles(pages);
      if (merged.length >= bars) break;
      endTime = Number(rows[0][0]) - 1;
    } catch (e) {
      error = { code: "network", message: `Binance hálózati hiba (${symbol}): ${String(e)}` };
      break;
    }
  }

  const merged = mergeCandles(pages).slice(-bars);
  return { candles: merged, quality: assessHistory(merged, timeframe, bars), error };
}

/** Csak a záróárak (a meglévő SMA/momentum függvényekhez). */
export const closesOf = (candles: OhlcvCandle[]): number[] => candles.map((c) => c.close);

/** ATR-hez való band: VALÓDI high/low, nem close-only. */
export const bandsOf = (candles: OhlcvCandle[]): { high: number; low: number; close: number }[] =>
  candles.map((c) => ({ high: c.high, low: c.low, close: c.close }));

import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

/**
 * Határidős pozicionáltság a Binance USDT-M futuresről — KULCS NÉLKÜL, ingyen.
 *
 * Miért kell: a meglévő jellemzők (return1h, return4h, volatility4h, volumeRatio) MIND
 * ugyanabból az árfolyamsorból származnak, ezért erősen korreláltak — az out-of-sample
 * AUC 0.524 lett, azaz érme-feldobás. A funding, az OI és a taker-flow NEM az árat méri,
 * hanem a tömeg pozícióját: ez ortogonális információ.
 *
 * Adatmélység (2026-09-06-i mérés): az `openInterestHist` és a taker/long-short csak
 * ~21-30 napra nyúlik vissza, a `fundingRate` viszont hónapokra. Ezért a tanításban a
 * funding használható, az OI és a taker-flow inkább ÉLŐ döntési kontextus.
 */
const FUTURES_BASE = "https://fapi.binance.com";

/** A legutolsó finanszírozási ráta SZÁZALÉKBAN. `null`, ha nincs adat. */
export function parseFundingRate(rows: unknown[]): number | null {
  const last = rows[rows.length - 1] as { fundingRate?: string } | undefined;
  const raw = last?.fundingRate;
  if (raw === undefined) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v * 100 : null;
}

export interface OpenInterestReading {
  openInterestBase: number | null;
  openInterestUsd: number | null;
  openInterestChange1hPct: number | null;
}

/**
 * A legfrissebb OI és az előző órás mintához mért változás.
 * Egyetlen mintából NINCS változás — a kitalált 0% hamis nyugalmat sugallna.
 */
export function parseOpenInterest(rows: unknown[]): OpenInterestReading {
  const typed = rows as { sumOpenInterest?: string; sumOpenInterestValue?: string }[];
  const last = typed[typed.length - 1];
  const prev = typed.length >= 2 ? typed[typed.length - 2] : undefined;
  const base = last?.sumOpenInterest !== undefined ? Number(last.sumOpenInterest) : null;
  const usd = last?.sumOpenInterestValue !== undefined ? Number(last.sumOpenInterestValue) : null;
  const prevBase = prev?.sumOpenInterest !== undefined ? Number(prev.sumOpenInterest) : null;
  const change =
    base !== null && prevBase !== null && Number.isFinite(base) && Number.isFinite(prevBase) && prevBase > 0
      ? ((base - prevBase) / prevBase) * 100
      : null;
  return {
    openInterestBase: base !== null && Number.isFinite(base) ? base : null,
    openInterestUsd: usd !== null && Number.isFinite(usd) ? usd : null,
    openInterestChange1hPct: change,
  };
}

/** Agresszív vételi/eladási forgalom aránya. */
export function parseTakerRatio(rows: unknown[]): number | null {
  const last = rows[rows.length - 1] as { buySellRatio?: string } | undefined;
  if (last?.buySellRatio === undefined) return null;
  const v = Number(last.buySellRatio);
  return Number.isFinite(v) ? v : null;
}

/** Lakossági számlák long/short aránya. */
export function parseLongShortRatio(rows: unknown[]): number | null {
  const last = rows[rows.length - 1] as { longShortRatio?: string } | undefined;
  if (last?.longShortRatio === undefined) return null;
  const v = Number(last.longShortRatio);
  return Number.isFinite(v) ? v : null;
}

export class BinanceDerivativesCollector implements DataCollector {
  name = "binance-futures";
  private errors: string[] = [];

  constructor(
    private symbols: string[],
    private opts: { fetchImpl?: typeof fetch; pair?: string; now?: () => number } = {},
  ) {}

  private async json(url: string, label: string): Promise<unknown[] | null> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(url);
      if (!res.ok) {
        this.errors.push(`${label}: HTTP ${res.status}`);
        return null;
      }
      const rows = await res.json();
      return Array.isArray(rows) ? rows : null;
    } catch (e) {
      this.errors.push(`${label}: ${String(e)}`);
      return null;
    }
  }

  async collect(): Promise<DataPoint[]> {
    this.errors = [];
    const now = this.opts.now ?? (() => Date.now());
    const pair = this.opts.pair ?? "USDT";
    const out: DataPoint[] = [];

    for (const symbol of this.symbols) {
      const s = `${symbol}${pair}`;
      const [funding, oi, taker, ls] = await Promise.all([
        this.json(`${FUTURES_BASE}/fapi/v1/fundingRate?symbol=${s}&limit=1`, `${symbol} funding`),
        this.json(`${FUTURES_BASE}/futures/data/openInterestHist?symbol=${s}&period=1h&limit=2`, `${symbol} OI`),
        this.json(`${FUTURES_BASE}/futures/data/takerlongshortRatio?symbol=${s}&period=1h&limit=1`, `${symbol} taker`),
        this.json(
          `${FUTURES_BASE}/futures/data/globalLongShortAccountRatio?symbol=${s}&period=1h&limit=1`,
          `${symbol} long/short`,
        ),
      ]);

      // Ha EGYETLEN mező sem jött meg, nincs mit jelenteni erre a coinra.
      if (!funding && !oi && !taker && !ls) continue;

      const oiReading = parseOpenInterest(oi ?? []);
      out.push({
        source: "binance-futures",
        symbol,
        timestamp: now(),
        kind: "derivatives",
        derivatives: {
          fundingRatePct: parseFundingRate(funding ?? []),
          openInterestBase: oiReading.openInterestBase,
          openInterestUsd: oiReading.openInterestUsd,
          openInterestChange1hPct: oiReading.openInterestChange1hPct,
          takerBuySellRatio: parseTakerRatio(taker ?? []),
          longShortAccountRatio: parseLongShortRatio(ls ?? []),
        },
      });
    }
    return out;
  }

  /** Strukturált hiba a néma degradáció ellen (lásd a Binance OHLC collector tanulságát). */
  lastError(): string | null {
    return this.errors.length > 0 ? this.errors.join(" · ") : null;
  }
}

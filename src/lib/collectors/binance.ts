import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";
import {
  fetchClosedCandles,
  TIMEFRAME_MS,
  type OhlcvCandle,
  type Timeframe,
  type FetchResult,
} from "@/lib/market/candles";

/**
 * Binance publikus piaci adat — LEZÁRT OHLC gyertyák (klines). Ingyenes, KULCS NÉLKÜL.
 *
 * T12 javítás (audit §5): a régi collector megtartotta a még nem lezárt gyertyát, és
 * annak JÖVŐBELI zárási idejét adta timestampnek — a tick ezt választotta „legfrissebb
 * árnak". Emellett csak a close-t hordozta, ezért az ATR close-only lett.
 *
 * Mostantól:
 *  - csak lezárt gyertya kerül be, a timestamp a MÚLTBELI closeTime;
 *  - a DataPoint hordozza a teljes OHLCV-t (valódi high/low, base ÉS quote volume);
 *  - az alapértelmezett mennyiség fedezi a legnagyobb visszatekintést (momentum 48 + warmup);
 *  - a rate limit és a hálózati hiba STRUKTURÁLTAN látszik, nem néma üres sorozat.
 */
export class BinanceOHLCCollector implements DataCollector {
  name = "binance";

  /** Az utolsó lekérés minősége symbolonként (a tick és a diagnosztika olvassa). */
  lastResults: Record<string, FetchResult> = {};

  constructor(
    private symbols: string[],
    private interval: Timeframe = "1h",
    /** Alapértelmezés: 72 lezárt gyertya — a 48 órás momentum-ablak + bőséges warmup. */
    private bars = 72,
    private opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
  ) {}

  async collect(): Promise<DataPoint[]> {
    const out: DataPoint[] = [];
    this.lastResults = {};
    for (const sym of this.symbols) {
      const result = await fetchClosedCandles(sym, this.interval, this.bars, this.opts);
      this.lastResults[sym] = result;
      if (result.error) {
        console.error(`[Binance] ${sym}: ${result.error.code} — ${result.error.message}`);
      }
      for (const c of result.candles) out.push(candleToDataPoint(c));
    }
    return out;
  }

  /**
   * A lekérés strukturált hibái egy sorban, symbolonként. `null`, ha minden forrás rendben.
   * A `collect()` szándékosan nem dob: egy coin hibája nem veheti el a többi gyertyáit.
   */
  lastError(): string | null {
    const failed = Object.entries(this.lastResults)
      .filter(([, r]) => r.error)
      .map(([sym, r]) => `${sym}: ${r.error!.code} — ${r.error!.message}`);
    return failed.length > 0 ? failed.join(" · ") : null;
  }
}

/** Egy lezárt gyertya DataPoint alakban. A timestamp a MÚLTBELI zárási idő. */
export function candleToDataPoint(c: OhlcvCandle): DataPoint {
  return {
    source: "binance",
    symbol: c.symbol,
    timestamp: c.closeTime,
    kind: "price",
    price: {
      usd: c.close,
      // A `volume24h` mező a régi olvasók miatt marad, de a jelentése itt a GYERTYA
      // base-volumene. A modellezés a lenti `ohlcv` mezőt használja, nem ezt.
      volume24h: c.baseVolume,
      change24hPct: c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0,
    },
    ohlcv: {
      timeframe: c.timeframe,
      openTime: c.openTime,
      closeTime: c.closeTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      baseVolume: c.baseVolume,
      quoteVolume: c.quoteVolume,
      trades: c.trades,
    },
  };
}

/** A DataPoint-ok visszaalakítása gyertyákká (a tick és a feature-építés használja). */
export function candlesFromDataPoints(events: DataPoint[], symbol: string): OhlcvCandle[] {
  const out: OhlcvCandle[] = [];
  for (const e of events) {
    if (e.source !== "binance" || e.symbol !== symbol || !e.ohlcv) continue;
    out.push({
      symbol,
      timeframe: e.ohlcv.timeframe as Timeframe,
      openTime: e.ohlcv.openTime,
      closeTime: e.ohlcv.closeTime,
      open: e.ohlcv.open,
      high: e.ohlcv.high,
      low: e.ohlcv.low,
      close: e.ohlcv.close,
      baseVolume: e.ohlcv.baseVolume,
      quoteVolume: e.ohlcv.quoteVolume,
      trades: e.ohlcv.trades,
      receivedAt: e.timestamp,
    });
  }
  return out.sort((a, b) => a.openTime - b.openTime);
}

export { TIMEFRAME_MS };

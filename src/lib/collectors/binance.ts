import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

/**
 * Binance publikus piaci adat — OHLC gyertyák (klines). Ingyenes, KULCS NÉLKÜL.
 * Lásd spec §3.1. Coinonként az utolsó N órás gyertyát adja vissza "price"
 * adatpontként (close + volume), így a buildFeatures valódi idősorból tud
 * return/volatilitás feature-t számolni (eddig csak 1 pont volt → üres ML-jel).
 *
 * A nyers gyertyák az ML-t etetik; az LLM kontextusból a motor kiszűri őket,
 * hogy a prompt ne teljen meg 24×3 ár-ponttal.
 */
export class BinanceOHLCCollector implements DataCollector {
  name = "binance";
  constructor(
    private symbols: string[],
    private interval = "1h",
    private limit = 24,
  ) {}

  async collect(): Promise<DataPoint[]> {
    const out: DataPoint[] = [];
    for (const sym of this.symbols) {
      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${this.interval}&limit=${this.limit}`;
        const res = await fetch(url);
        if (!res.ok) {
          console.error("[Binance] HTTP", res.status, sym);
          continue;
        }
        const candles = (await res.json()) as unknown[][];
        for (const k of candles) {
          const open = Number(k[1]);
          const close = Number(k[4]);
          const volume = Number(k[5]);
          const closeTime = Number(k[6]);
          if (!Number.isFinite(close)) continue;
          out.push({
            source: "binance",
            symbol: sym,
            timestamp: closeTime,
            kind: "price",
            price: {
              usd: close,
              volume24h: Number.isFinite(volume) ? volume : 0,
              change24hPct: open ? ((close - open) / open) * 100 : 0,
            },
          });
        }
      } catch (e) {
        console.error("[Binance]", sym, e);
      }
    }
    return out;
  }
}

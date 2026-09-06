import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

/**
 * Tőzsdék közötti prémium: Coinbase (USD, US-piac) vs Binance (USDT, offshore).
 *
 * A pozitív prémium hagyományosan US-oldali keresletet jelez, a negatív offshore
 * eladói nyomást. Az árra ortogonális jel, és — a derivatíva-adattal ellentétben —
 * a Coinbase gyertyái ÉVEKRE visszanyúlnak, tehát ML-tanításra is alkalmas.
 *
 * FONTOS: ez a collector szándékosan NEM ad `kind: "price"` adatpontot. A tick az
 * árakat minden price-eseményből építi (a legfrissebb nyer), így egy USD-alapú
 * Coinbase-ár összekeveredne a USDT-alapú végrehajtási árakkal.
 */
const COINBASE_BASE = "https://api.exchange.coinbase.com";
const BINANCE_BASE = "https://api.binance.com";

/** A prémium százalékban. `null`, ha a referencia nem értelmes. */
export function premiumPct(venuePrice: number, referencePrice: number): number | null {
  if (!Number.isFinite(venuePrice) || !Number.isFinite(referencePrice) || referencePrice <= 0) return null;
  return ((venuePrice - referencePrice) / referencePrice) * 100;
}

export class CoinbasePremiumCollector implements DataCollector {
  name = "coinbase-premium";
  private errors: string[] = [];

  constructor(
    private symbols: string[],
    private opts: { fetchImpl?: typeof fetch; now?: () => number; fiat?: string; pair?: string } = {},
  ) {}

  private async price(url: string, label: string, field: "price"): Promise<number | null> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(url);
      if (!res.ok) {
        this.errors.push(`${label}: HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as Record<string, string>;
      const v = Number(body[field]);
      return Number.isFinite(v) ? v : null;
    } catch (e) {
      this.errors.push(`${label}: ${String(e)}`);
      return null;
    }
  }

  async collect(): Promise<DataPoint[]> {
    this.errors = [];
    const now = this.opts.now ?? (() => Date.now());
    const fiat = this.opts.fiat ?? "USD";
    const pair = this.opts.pair ?? "USDT";
    const out: DataPoint[] = [];

    for (const symbol of this.symbols) {
      const [venue, reference] = await Promise.all([
        this.price(`${COINBASE_BASE}/products/${symbol}-${fiat}/ticker`, `${symbol} coinbase`, "price"),
        this.price(`${BINANCE_BASE}/api/v3/ticker/price?symbol=${symbol}${pair}`, `${symbol} binance`, "price"),
      ]);
      if (venue === null || reference === null) continue;
      const pct = premiumPct(venue, reference);
      if (pct === null) continue;
      out.push({
        source: "coinbase",
        symbol,
        timestamp: now(),
        kind: "premium",
        premium: { venue: "coinbase", venuePrice: venue, referencePrice: reference, premiumPct: pct },
      });
    }
    return out;
  }

  lastError(): string | null {
    return this.errors.length > 0 ? this.errors.join(" · ") : null;
  }
}

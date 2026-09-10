import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

const CG_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
};

/** Meddig várunk a CoinGecko-ra. A dashboard 60 másodpercenként kér — nem várhat tovább. */
const CG_TIMEOUT_MS = 8_000;

/**
 * CoinGecko simple price API (ingyenes tier). Lásd spec §3.1.
 * A coin id-k ismertek (bitcoin/ethereum/solana), kis kosárhoz elég az ingyenes kvóta.
 *
 * A hiba NEM néma. A régi változat egy 429-re (az ingyenes tier gyakori válasza felhő-IP-ről)
 * `console.error`-t írt és üres listát adott vissza, `lastError()` viszont nem volt — a
 * `collectAllWithOutcomes` így `ok: true, points: 0`-t jelentett. A dashboard ettől
 * „rendben" forrást mutatott, miközben ár nélkül maradt, és a nyitott pozíció P&L-je
 * belépési áron ragadt: a százalék nem mozdult.
 */
export class CoinGeckoCollector implements DataCollector {
  name = "coingecko";
  private symbols: string[];
  private error: string | null = null;

  constructor(symbols: string[]) {
    this.symbols = symbols;
  }

  async collect(): Promise<DataPoint[]> {
    this.error = null;
    const ids = this.symbols.map((s) => CG_ID[s]).filter(Boolean).join(",");
    if (!ids) return [];
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;

    let data: Record<string, { usd?: number; usd_24h_vol?: number; usd_24h_change?: number }>;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(CG_TIMEOUT_MS) });
      if (!res.ok) {
        // A 429 a leggyakoribb: az ingyenes tier percenkénti kvótája megosztott IP-ken hamar elfogy.
        this.error = `HTTP ${res.status}${res.status === 429 ? " (rate limit)" : ""}`;
        console.error("[CoinGecko] HTTP", res.status);
        return [];
      }
      data = await res.json();
    } catch (e) {
      this.error = String(e);
      console.error("[CoinGecko] lekérés hiba:", e);
      return [];
    }

    const ts = Date.now();
    const points = this.symbols
      .filter((s) => CG_ID[s] && data[CG_ID[s]] && typeof data[CG_ID[s]].usd === "number")
      .map((s) => {
        const d = data[CG_ID[s]];
        return {
          source: "coingecko" as const,
          symbol: s,
          timestamp: ts,
          kind: "price" as const,
          price: {
            usd: d.usd as number,
            volume24h: d.usd_24h_vol as number,
            change24hPct: d.usd_24h_change as number,
          },
        };
      });

    // A RÉSZLEGES válasz is hiba: a hiányzó coin ára a jel-láncban és a dashboardon is hiányzik.
    const missing = this.symbols.filter((s) => CG_ID[s] && !points.some((p) => p.symbol === s));
    if (missing.length > 0) this.error = `hiányzó ár: ${missing.join(", ")}`;
    return points;
  }

  /** Az utolsó lekérés hibája (HTTP, hálózat, hiányzó coin). `null`, ha minden ár megjött. */
  lastError(): string | null {
    return this.error;
  }
}

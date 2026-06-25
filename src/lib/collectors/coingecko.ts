import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

const CG_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
};

/**
 * CoinGecko simple price API (ingyenes tier). Lásd spec §3.1.
 * A coin id-k ismertek (bitcoin/ethereum/solana), kis kosárhoz elég az ingyenes kvóta.
 */
export class CoinGeckoCollector implements DataCollector {
  name = "coingecko";
  private symbols: string[];

  constructor(symbols: string[]) {
    this.symbols = symbols;
  }

  async collect(): Promise<DataPoint[]> {
    const ids = this.symbols.map((s) => CG_ID[s]).filter(Boolean).join(",");
    if (!ids) return [];
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[CoinGecko] HTTP", res.status);
      return [];
    }
    const data = await res.json();
    const ts = Date.now();
    return this.symbols
      .filter((s) => CG_ID[s] && data[CG_ID[s]])
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
  }
}

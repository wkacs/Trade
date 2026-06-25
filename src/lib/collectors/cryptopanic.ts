import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

interface CpResult {
  title: string;
  url: string;
  currency?: { code: string };
  votes: { positive: number; negative: number; important: number };
}

/**
 * CryptoPanic ingyenes API — hírek + vote-alapú sentiment.
 * Lásd spec §3.1. A token az ingyenes regisztráció után jár.
 */
export class CryptoPanicCollector implements DataCollector {
  name = "cryptopanic";
  constructor(private authToken: string, private symbols: string[]) {}

  async collect(): Promise<DataPoint[]> {
    if (!this.authToken) return [];
    const filter = this.symbols.map((s) => s.toUpperCase()).join(",");
    const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${this.authToken}&currencies=${filter}&kind=news`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[CryptoPanic] HTTP", res.status);
      return [];
    }
    const data = (await res.json()) as { results: CpResult[] };
    const ts = Date.now();
    return data.results
      .filter((r) => r.currency?.code && this.symbols.includes(r.currency.code.toUpperCase()))
      .map((r) => {
        const sentiment =
          r.votes.positive > r.votes.negative
            ? "bullish"
            : r.votes.negative > r.votes.positive
              ? "bearish"
              : "neutral";
        return {
          source: "cryptopanic" as const,
          symbol: r.currency!.code.toUpperCase(),
          timestamp: ts,
          kind: "news" as const,
          news: { title: r.title, url: r.url, sentiment },
        };
      });
  }
}

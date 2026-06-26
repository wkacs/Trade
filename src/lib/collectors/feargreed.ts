import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

/**
 * Crypto Fear & Greed Index (alternative.me) — ingyenes, kulcs nélküli piaci
 * hangulat-mutató (0..100). 0 = extrém félelem, 100 = extrém mohóság.
 * Lásd spec §3.1 (bővíthető plug-in gyűjtő). Piac-szintű jel, ezért a symbol "CRYPTO".
 */
export class FearGreedCollector implements DataCollector {
  name = "feargreed";

  async collect(): Promise<DataPoint[]> {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    if (!res.ok) {
      console.error("[FearGreed] HTTP", res.status);
      return [];
    }
    const data = (await res.json()) as {
      data?: { value: string; value_classification: string; timestamp: string }[];
    };
    const item = data.data?.[0];
    if (!item) return [];
    const value = Number(item.value);
    if (!Number.isFinite(value)) return [];
    return [
      {
        source: "alternative",
        symbol: "CRYPTO",
        timestamp: Date.now(),
        kind: "sentiment",
        sentiment: { value, classification: item.value_classification },
      },
    ];
  }
}

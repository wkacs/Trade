import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

const EXCHANGES = new Set(["binance", "kraken", "coinbase", "okx", "bybit", "huobi", "bitfinex"]);

interface WaTx {
  symbol: string;
  amount_usd: number;
  blockchain?: string;
  from?: { owner?: string };
  to?: { owner?: string };
}

/**
 * WhaleAlert ingyenes API — nagy (>500k USD) on-chain tranzakciók.
 * Irány: exchange-in = tőzsdére (gyakran eladás jel),
 * exchange-out = tőzsdéről (felhalmozás). Lásd spec §3.1.
 */
export class WhaleAlertCollector implements DataCollector {
  name = "whalealert";
  constructor(private apiKey: string, private symbols: string[]) {}

  async collect(): Promise<DataPoint[]> {
    if (!this.apiKey) return [];
    // Utolsó 1 óra nagy tranzakciói
    const start = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
    const url = `https://api.whale-alert.io/v1/transactions?api_key=${this.apiKey}&min-value=500000&start=${start}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[WhaleAlert] HTTP", res.status);
      return [];
    }
    const data = (await res.json()) as { result?: WaTx[] };
    const ts = Date.now();
    return (data.result ?? [])
      .filter((t) => this.symbols.includes(t.symbol.toUpperCase()))
      .map((t) => {
        const fromEx = EXCHANGES.has((t.from?.owner ?? "").toLowerCase());
        const toEx = EXCHANGES.has((t.to?.owner ?? "").toLowerCase());
        const direction =
          toEx && !fromEx ? "exchange-in" : fromEx && !toEx ? "exchange-out" : "exchange-in";
        return {
          source: "whalealert" as const,
          symbol: t.symbol.toUpperCase(),
          timestamp: ts,
          kind: "whale" as const,
          whale: {
            amountUsd: t.amount_usd,
            direction,
            from: t.from?.owner ?? "unknown",
            to: t.to?.owner ?? "unknown",
          },
        };
      });
  }
}

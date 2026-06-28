/** Egy adatgyűjtőtől érkező normalizált adatpont. */
export interface DataPoint {
  source: "coingecko" | "cryptopanic" | "whalealert" | "rss" | "binance" | "alternative" | "reddit";
  symbol: string;
  timestamp: number; // epoch ms
  kind: "price" | "news" | "whale" | "rss" | "sentiment" | "social";
  // Tartalom a kind-től függően:
  price?: { usd: number; volume24h: number; change24hPct: number };
  news?: { title: string; url: string; sentiment: "bullish" | "bearish" | "neutral" };
  whale?: { amountUsd: number; direction: "exchange-in" | "exchange-out"; from: string; to: string };
  rss?: { title: string; url: string; source: string };
  /** Piaci hangulat (Fear & Greed Index): value 0..100, classification szöveges címke. */
  sentiment?: { value: number; classification: string };
  /** Közösségi poszt (Reddit): cím + felfutás (score = figyelem-jel) + subreddit. */
  social?: { title: string; score: number; subreddit: string };
}

/** ML jelzések egy coinra, egy időpontban. */
export interface MlSignal {
  symbol: string;
  timestamp: number;
  direction1h: "up" | "down" | "flat"; // előrejelzett irány 1 órás horizontra
  confidence: number; // 0..1
  volatilityPct: number; // előrejelzett volatilitás %
}

/** Az AI által javasolt döntés (fázis-2 kimenet, Risk Manager előtt). */
export interface RawDecision {
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  amountPct: number; // a tőke hányada (BUY/SELL esetén)
  confidence: number; // 0..1
  reasoning: string; // kötelező — a „saját vélemény"
  model: string;
}

/** Risk Manager által validált végleges döntés. */
export interface Decision extends RawDecision {
  id: string;
  timestamp: number;
  overridden: boolean; // true, ha a Risk Manager módosította/elutasította
  overrideReason?: string;
}

/** Végrehajtható order a broker felé. */
export interface Order {
  side: "BUY" | "SELL";
  symbol: string;
  amountUsd: number;
  stopLossPct: number;
}

/** Egy végrehajtott tranzakció eredménye. */
export interface Trade {
  id: string;
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  amountUsd: number;
  price: number; // USD / coin
  qty: number;
  feeUsd: number;
  executedAt: number;
  mode: "paper" | "live";
  /** Mi hajtotta a trade-et: profit-ciklus (dca/stop-loss/take-profit) vagy AI. */
  origin?: import("@/lib/engine/tick-process").TradeOrigin;
}

/** Egy adatgyűjtőtől érkező normalizált adatpont. */
export interface DataPoint {
  source:
    | "coingecko"
    | "cryptopanic"
    | "whalealert"
    | "rss"
    | "binance"
    | "binance-futures"
    | "coinbase"
    | "alternative"
    | "reddit";
  symbol: string;
  timestamp: number; // epoch ms
  kind: "price" | "news" | "whale" | "rss" | "sentiment" | "social" | "derivatives" | "premium";
  // Tartalom a kind-től függően:
  price?: { usd: number; volume24h: number; change24hPct: number };
  /**
   * Teljes, LEZÁRT tőzsdei gyertya (T12). Csak a `binance` forrás tölti ki. A modellezés
   * (ATR, momentum, ML feature) ezt használja — a `price.usd`-only út elveszítette a
   * high/low-t, és összekeverte a Binance órás mennyiségét a CoinGecko 24 órás volumenével.
   */
  ohlcv?: {
    timeframe: string;
    openTime: number;
    closeTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    baseVolume: number;
    quoteVolume: number;
    trades: number;
  };
  news?: { title: string; url: string; sentiment: "bullish" | "bearish" | "neutral" };
  whale?: { amountUsd: number; direction: "exchange-in" | "exchange-out"; from: string; to: string };
  rss?: { title: string; url: string; source: string };
  /** Piaci hangulat (Fear & Greed Index): value 0..100, classification szöveges címke. */
  sentiment?: { value: number; classification: string };
  /** Közösségi poszt (Reddit): cím + felfutás (score = figyelem-jel) + subreddit. */
  social?: { title: string; score: number; subreddit: string };
  /**
   * Határidős pozicionáltság (Binance USDT-M futures, kulcs nélkül). Ez ORTOGONÁLIS
   * az árra: nem azt mondja, mennyi az ár, hanem hogy a tömeg hogyan áll benne.
   * A hiányzó mező `null`, SOHA nem 0 — a nulla funding valós érték.
   */
  derivatives?: {
    /** Finanszírozási ráta százalékban (0.01 = 0.01%). */
    fundingRatePct: number | null;
    /** Nyitott pozíció bázis-eszközben és quote-ban. */
    openInterestBase: number | null;
    openInterestUsd: number | null;
    /** Az OI változása az előző órás mintához képest, százalékban. */
    openInterestChange1hPct: number | null;
    /** Agresszív vételi / eladási forgalom aránya (>1 = vevői nyomás). */
    takerBuySellRatio: number | null;
    /** Lakossági számlák long/short aránya (>1 = long-túlsúly). */
    longShortAccountRatio: number | null;
  };
  /**
   * Tőzsdék közötti árkülönbség (Coinbase USD vs Binance USDT). A pozitív prémium
   * hagyományosan US-oldali keresletet jelez.
   */
  premium?: { venue: string; venuePrice: number; referencePrice: number; premiumPct: number };
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

/**
 * Végrehajtható order a broker felé.
 *
 * @deprecated v1 — kétértelmű `amountUsd`. Az új, verziózott szerződés a
 * `@/lib/execution/contracts` `ExecutionOrder`-e: BUY `maxQuoteSpend`, SELL `baseQty`.
 * Ez a típus a kompatibilitási adapterek (fromLegacyOrder/toLegacyOrder) miatt marad.
 */
export interface Order {
  side: "BUY" | "SELL";
  symbol: string;
  amountUsd: number;
  stopLossPct: number;
}

// A v2 szerződés újraexportálva, hogy egy helyről (types) is elérhető legyen.
export type {
  ExecutionOrder,
  ExecutionIntent,
  IntentMeta,
  Fill,
  OrderState,
  TradingMode as ExecutionMode,
} from "@/lib/execution/contracts";

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

import { DEFAULT_STRATEGY } from "@/lib/strategy/config";

export interface RiskLimits {
  /** Egy pozíció maximális része a teljes tőkéből (0.2 = 20%). */
  maxPositionPct: number;
  /** Kötelező stop-loss (0.05 = -5%). */
  stopLossPct: number;
  /** Tőkeáttétel (1 = nincs). */
  leverage: number;
  /** Maximális egyidejű pozíciók száma. */
  maxConcurrentPositions: number;
  /** Napi max veszteség, ami HOLD-only circuit breakert aktivál (0.03 = -3%). */
  dailyLossCircuitBreakerPct: number;
}

/**
 * Konzervatív kockázati limitlek — védik a kis tőkét. Lásd spec §3.4.
 *
 * T15: EGY forrás. Ezek az értékek a `DEFAULT_STRATEGY`-ből SZÁRMAZNAK, nem külön
 * másolatok. A régi kód két helyen tartotta ugyanazt a paramétert, és a kettő
 * elcsúszhatott (config drift, audit §6).
 */
export const RISK_LIMITS: RiskLimits = {
  maxPositionPct: DEFAULT_STRATEGY.maxPositionPct,
  stopLossPct: DEFAULT_STRATEGY.stopLossPct,
  leverage: 1,
  maxConcurrentPositions: DEFAULT_STRATEGY.maxConcurrentPositions,
  dailyLossCircuitBreakerPct: DEFAULT_STRATEGY.dailyLossCircuitBreakerPct,
};

/**
 * Profit-ciklus paraméterek (kód-alapú stop-loss + take-profit + fear-greedy DCA).
 * Lásd: docs/superpowers/specs/2026-06-26-profit-cycle-design.md §3.7.
 */
export const PROFIT_CYCLE = {
  takeProfitPct: DEFAULT_STRATEGY.takeProfitPct,
  dcaFgThreshold: DEFAULT_STRATEGY.dcaFgThreshold,
  dcaWeeklyBudgetPct: DEFAULT_STRATEGY.dcaWeeklyBudgetPct,
  dcaBuyPct: DEFAULT_STRATEGY.dcaBuyPct,
  dcaMax24hDropPct: DEFAULT_STRATEGY.dcaMax24hDropPct,
} as const;

/** Fix coin kosár USDT párban. Bővíthető a settings-en keresztül. Lásd spec §3.6. */
export const COIN_UNIVERSE = ["BTC", "ETH", "SOL"] as const;
export type CoinSymbol = (typeof COIN_UNIVERSE)[number];

/**
 * Ingyenes, legális RSS hír-források (nem kell API kulcs). A gyűjtő a cikk címéből
 * coin-szimbólumot (BTC/ETH/SOL) detektál; ami nem coin-specifikus, az "CRYPTO"
 * általános piaci kontextusként kerül be. Lásd spec §3.1. Bővíthető további feedekkel.
 */
export const RSS_SOURCES = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", symbol: "CRYPTO" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss", symbol: "CRYPTO" },
];

/**
 * Ingyenes, kulcs nélküli Reddit közösségi források (publikus JSON). A gyűjtő a poszt
 * címéből coin-szimbólumot detektál; a score = figyelem-jel. Lásd spec §3.1.
 * Megj.: a Reddit datacenter-IP-t (Vercel) blokkolhat — lokálisan megbízható.
 */
export const REDDIT_SOURCES: { subreddit: string; sort: "hot" | "top" | "new" }[] = [
  { subreddit: "CryptoCurrency", sort: "hot" },
  { subreddit: "Bitcoin", sort: "hot" },
];

export type TradingMode = "paper" | "live";

/** Visszaadja a jelenlegi kereskedési módot (env-ből). Alapértelmezett: paper. */
export function getTradingMode(): TradingMode {
  const mode = process.env.TRADING_MODE ?? "paper";
  return mode === "live" ? "live" : "paper";
}

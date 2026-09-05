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

/**
 * Az ütemező szerepe (T28).
 *
 * PONTOSAN EGY aktív ütemező lehet. Három hely tudna tickelni:
 *   - `worker`         → állandó folyamat (5 perces kilépés + órás belépés) — TELJES működés
 *   - `github-actions` → óránkénti runner (`scripts/tick.ts`) — CSAK órás belépés, nincs 5 perces kilépés
 *   - `vercel-cron`    → a `/api/cron/tick` route Vercel ütemezéssel — 60s limit miatt megbízhatatlan
 *
 * A lease (T10) második védvonalként úgyis kizárja a dupla futást ugyanarra a sávra, de
 * a konfiguráció szintjén is egyértelműnek kell lennie, KI az ütemező — különben senki
 * nem tudja, melyik naplót kell nézni, és a „miért nem futott" kérdés megválaszolhatatlan.
 */
export type SchedulerRole = "worker" | "github-actions" | "vercel-cron";

const SCHEDULER_ROLES: SchedulerRole[] = ["worker", "github-actions", "vercel-cron"];

/** A beállított ütemező. Alapértelmezés: `github-actions` (ez fut ma, ingyen). */
export function getSchedulerRole(): SchedulerRole {
  const raw = (process.env.SCHEDULER ?? "github-actions").trim();
  return (SCHEDULER_ROLES as string[]).includes(raw) ? (raw as SchedulerRole) : "github-actions";
}

/** Igaz, ha a SCHEDULER értéke érvénytelen (elgépelés esetén ne csendben default-oljunk). */
export function isSchedulerRoleValid(): boolean {
  const raw = process.env.SCHEDULER;
  return raw === undefined || (SCHEDULER_ROLES as string[]).includes(raw.trim());
}

/**
 * Ellenőrzés indításkor: a hívó az AKTÍV ütemező-e.
 *
 * Nem dob kivételt — a hívó dönti el, mit tesz. A kilépés-ciklus (`--once exit`) és a
 * kézi futtatás akkor is megengedett, ha nem ez az aktív ütemező; a FOLYAMATOS futás nem.
 */
export function schedulerGuard(role: SchedulerRole): { active: boolean; configured: SchedulerRole; message: string } {
  const configured = getSchedulerRole();
  if (!isSchedulerRoleValid()) {
    return {
      active: false,
      configured,
      message: `Ismeretlen SCHEDULER érték: "${process.env.SCHEDULER}". Érvényes: ${SCHEDULER_ROLES.join(", ")}.`,
    };
  }
  if (configured === role) return { active: true, configured, message: `Az aktív ütemező: ${role}.` };
  return {
    active: false,
    configured,
    message:
      `Ez a folyamat "${role}", de az aktív ütemező a beállítás szerint "${configured}". ` +
      "EGY aktív ütemező lehet — állítsd a SCHEDULER változót, vagy állítsd le a másikat.",
  };
}

import { getDb, schema } from "@/db/client";
import { isNull } from "drizzle-orm";

/**
 * Portfólió-accounting: a DB-ből tölti a jelenlegi állapotot,
 * és inicializálja az új portfóliót kezdőtőkével.
 *
 * NOTE: a tick.ts jelenleg egyszerűsített kontextussal dolgozik (fix 10000 USD).
 * A teljes DB-integráció ezeken a függvényeken keresztül köthető be egy későbbi
 * feladatban — a felület már megvan. Lásd spec §7 (nyitott pontok).
 */

export interface PortfolioState {
  cashUsd: number;
  positions: { symbol: string; qty: number; valueUsd: number }[];
  totalEquity: () => number;
  dayPnlPct: number;
}

/** Betölti a jelenlegi portfólió-állapotot a DB-ből. */
export async function loadPortfolioState(): Promise<PortfolioState | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const portfolio = await db.query.portfolios.findFirst();
    const positions = await db.query.positions.findMany({
      where: isNull(schema.positions.closedAt),
    });

    if (!portfolio) return null;

    const positionsWithValue = positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      valueUsd: p.qty * p.entryPrice, // egyszerűsített; a valós érték az aktuális árral
    }));
    const cashUsd = portfolio.cashUsd;

    return {
      cashUsd,
      positions: positionsWithValue,
      totalEquity: () =>
        cashUsd + positionsWithValue.reduce((s, p) => s + p.valueUsd, 0),
      dayPnlPct: await computeDayPnlPct(),
    };
  } catch (e) {
    console.error("[accounting] loadPortfolioState hiba:", e);
    return null;
  }
}

/** Új portfólió inicializálása kezdőtőkével. Lásd spec §1. */
export async function initPortfolio(
  initialCapitalUsd: number,
  mode: "paper" | "live" = "paper",
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  try {
    await db.insert(schema.portfolios).values({
      initialCapitalUsd,
      cashUsd: initialCapitalUsd,
      mode,
    });
    return true;
  } catch (e) {
    console.error("[accounting] initPortfolio hiba:", e);
    return false;
  }
}

/**
 * Mai napi P&L % kiszámítása (a mai tranzakciókból).
 * Egyszerűsített: csak a realized SELL bevételeket számolja a nap elejéhez képest.
 * A teljes (realized + unrealized) P&L egy későbbi feladat.
 */
export async function computeDayPnlPct(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  try {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const todayTrades = await db.query.trades.findMany();
    const todaySells = todayTrades.filter(
      (t) => new Date(t.executedAt) >= startOfDay && t.side === "SELL",
    );

    // Naiv: SELL bevételek összege / kezdőtőke
    // A valós számítás az entry-vs-exit ár különbségből áll.
    const portfolio = await db.query.portfolios.findFirst();
    if (!portfolio) return 0;
    const sellsTotal = todaySells.reduce((s, t) => s + t.amountUsd, 0);
    return sellsTotal / portfolio.initialCapitalUsd - 1;
  } catch {
    return 0;
  }
}

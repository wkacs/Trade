import { getDb, schema, type Db } from "@/db/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Trade } from "@/lib/types";

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

/** Nagyon kis mennyiség küszöb: ez alatt a pozíció lezártnak számít (lebegőpontos zaj). */
const POSITION_CLOSE_EPSILON = 1e-7;

/**
 * Egy végrehajtott tradet tartósít a DB-be és frissíti a portfólió-állapotot.
 * Aggregált pozíció-modell: symbolonként egy nyitott sor (closedAt IS NULL).
 *
 * BUY  → cash -= amountUsd; nyitott pozíció upsert (súlyozott ár-átlagolás + stopPrice);
 *        trades insert(positionId). Ha nincs nyitott pozíció: új positions sor.
 * SELL → cash += amountUsd; pozíció qty csökkentése; ha qty ≈ 0 → closedAt + qty=0;
 *        trades insert(positionId).
 *
 * Sorrendben ír try/catch-ben, konzisztens a kódbázis többi DB-írásával (route.ts minta).
 * Nem igényel szigorú tranzakciót (paper mód, egy cron tick). Hiba esetén log + null.
 *
 * @param dbOverride opcionális — tesztelhetőség (mock db injektálás). Ha nem adjuk át
 *        (undefined), getDb()-t használ; explicit null = "nincs DB".
 * @returns { positionId } vagy null, ha nincs DB / hiba történt.
 */
export async function applyTrade(
  trade: Trade,
  stopPriceUsd: number,
  dbOverride?: Db | null,
): Promise<{ positionId: string | null } | null> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return null;

  try {
    // 1) Meglévő NYITOTT pozíció keresése a symbolra
    const [existing] = await db
      .select()
      .from(schema.positions)
      .where(
        and(
          eq(schema.positions.symbol, trade.symbol),
          isNull(schema.positions.closedAt),
        ),
      )
      .limit(1);

    let positionId: string | null;

    if (trade.side === "BUY") {
      if (existing) {
        // 2a) BUY növeli a meglévő pozíciót — súlyozott ár-átlagolás
        const oldQty = existing.qty;
        const newQty = oldQty + trade.qty;
        const avgEntry =
          (oldQty * existing.entryPrice + trade.qty * trade.price) / newQty;
        await db
          .update(schema.positions)
          .set({
            qty: newQty,
            entryPrice: avgEntry,
            stopPrice: stopPriceUsd,
          })
          .where(eq(schema.positions.id, existing.id));
        positionId = existing.id;
      } else {
        // 2b) BUY új pozíciót nyit
        const [inserted] = await db
          .insert(schema.positions)
          .values({
            symbol: trade.symbol,
            qty: trade.qty,
            entryPrice: trade.price,
            stopPrice: stopPriceUsd,
          })
          .returning();
        positionId = inserted?.id ?? null;
      }

      // Cash csökken a bruttó összeggel (fee már a qty-ben benne van a brokerben)
      await db
        .update(schema.portfolios)
        .set({ cashUsd: sql`cash_usd - ${trade.amountUsd}` })
        .where(eq(schema.portfolios.id, (await firstPortfolioId(db)) ?? ""));
    } else {
      // SELL — csökkentjük a pozíciót (ha van)
      if (existing) {
        const remaining = existing.qty - trade.qty;
        const closes = remaining <= POSITION_CLOSE_EPSILON;
        await db
          .update(schema.positions)
          .set({
            qty: closes ? 0 : remaining,
            ...(closes ? { closedAt: new Date() } : {}),
          })
          .where(eq(schema.positions.id, existing.id));
        positionId = existing.id;
      } else {
        // Nincs nyitott pozíció a symbolon — a trade akkor is rögzítendő (orphan SELL),
        // de positionId nélkül.
        positionId = null;
      }

      // Cash nő az eladás bevételével
      await db
        .update(schema.portfolios)
        .set({ cashUsd: sql`cash_usd + ${trade.amountUsd}` })
        .where(eq(schema.portfolios.id, (await firstPortfolioId(db)) ?? ""));
    }

    // 3) Trade sora — pozícióhoz kötve, ha van
    await db.insert(schema.trades).values({
      positionId,
      symbol: trade.symbol,
      side: trade.side,
      amountUsd: trade.amountUsd,
      price: trade.price,
      qty: trade.qty,
      feeUsd: trade.feeUsd,
      mode: trade.mode,
    });

    return { positionId };
  } catch (e) {
    console.error("[accounting] applyTrade hiba:", e);
    return null;
  }
}

/** Visszaadja az (egyetlen) portfolios sor id-ját. */
async function firstPortfolioId(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.portfolios.id })
    .from(schema.portfolios)
    .limit(1);
  return row?.id ?? null;
}

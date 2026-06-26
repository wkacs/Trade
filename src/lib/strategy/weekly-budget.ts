import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db/client";
import { PROFIT_CYCLE } from "@/lib/config";

/**
 * Heti DCA-keret követése (halmozási fegyelem + vészfék).
 * Lásd: docs/superpowers/specs/2026-06-26-profit-cycle-design.md §3.3.
 *
 * „Hét" = görgő 7 nap (nem naptári hétfő) — egyszerűbb és konzervatívabb.
 *
 * @param dbOverride opcionális — tesztelhetőség (mock db injektálás), az applyTrade
 *        mintáját követve. undefined → getDb(); explicit null → „nincs DB".
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Az elmúlt 7 nap DCA-vételeire (BUY, paper) elköltött USD a trades táblából. */
export async function spentThisWeekUsd(dbOverride?: Db | null): Promise<number> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return 0;

  const since = new Date(Date.now() - WEEK_MS);
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${schema.trades.amountUsd}), 0)` })
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.side, "BUY"),
        eq(schema.trades.mode, "paper"),
        gte(schema.trades.executedAt, since),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Hátralévő heti keret USD-ben (totalEquity * 5% − a héten elköltött). Sosem negatív.
 * Lekérdezési hiba esetén konzervatívan 0-t ad (mintha elfogyott volna → HOLD). Spec §5.
 */
export async function remainingWeeklyBudget(
  totalEquity: number,
  dbOverride?: Db | null,
): Promise<number> {
  const budget = totalEquity * PROFIT_CYCLE.dcaWeeklyBudgetPct;
  try {
    const spent = await spentThisWeekUsd(dbOverride);
    return Math.max(0, budget - spent);
  } catch (e) {
    console.error("[weekly-budget] lekérdezési hiba — konzervatívan 0 keret:", e);
    return 0;
  }
}

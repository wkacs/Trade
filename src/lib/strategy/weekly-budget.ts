import { and, eq, gte, sql, inArray } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db/client";
import { PROFIT_CYCLE } from "@/lib/config";
import { type Dec, ZERO, add, sub, mul, dec, max as decMax } from "@/lib/portfolio/money";

/**
 * Heti DCA-keret követése (halmozási fegyelem és vészfék) — T08.
 *
 * Az audit §4 két hibát bizonyított:
 *  1. a keretből MINDEN paper BUY levonódott, nem csak a DCA (így az AI vételei
 *     felélték a DCA keretét), és a live kötések egyáltalán nem számítottak bele;
 *  2. a beküldött, még nem teljesült DCA-foglalás nem fogyasztotta a keretet, ezért két
 *     egyidejű futó ugyanazt a keretet költhette el.
 *
 * A javítás: a keretet KIZÁRÓLAG az adott (portfolio, mode) hatókör `dca` eredetű
 * teljesülései és aktív foglalásai fogyasztják.
 *
 * „Hét" = görgő 7 nap (nem naptári hétfő) — egyszerűbb és konzervatívabb.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface BudgetScope {
  portfolioId: string;
  mode: "paper" | "live";
}

/**
 * Az elmúlt 7 nap DCA-vételeire elköltött quote-összeg.
 *
 * Forrás-sorrend (átmeneti, a T09-ig): elsődlegesen a v2 `execution_fills` +
 * `execution_intents` (hatókör- és eredet-helyes). Ha ebben a hatókörben MÉG NINCS
 * egyetlen v2 fill sem, visszaesünk a v1 `trades` táblára, ahol az `origin` és a `mode`
 * szűr — a v1-nek nincs portfolio oszlopa, ez a fallback ismert korlátja.
 */
export async function spentThisWeekUsd(
  scope: BudgetScope,
  nowMs: number = Date.now(),
  dbOverride?: Db | null,
): Promise<Dec> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return ZERO;

  const since = new Date(nowMs - WEEK_MS);

  // v2: csak a `dca` eredetű intentekhez tartozó fillek, a megadott hatókörben.
  const dcaIntents = await db
    .select({ intentId: schema.executionIntents.intentId })
    .from(schema.executionIntents)
    .where(
      and(
        eq(schema.executionIntents.portfolioId, scope.portfolioId),
        eq(schema.executionIntents.mode, scope.mode),
        eq(schema.executionIntents.origin, "dca"),
        eq(schema.executionIntents.side, "BUY"),
      ),
    );

  const anyV2Fill = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.executionFills)
    .where(and(eq(schema.executionFills.portfolioId, scope.portfolioId), eq(schema.executionFills.mode, scope.mode)));

  if (Number(anyV2Fill[0]?.c ?? 0) > 0) {
    if (dcaIntents.length === 0) return ZERO;
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${schema.executionFills.grossQuoteAmount}), 0)::text` })
      .from(schema.executionFills)
      .where(
        and(
          eq(schema.executionFills.portfolioId, scope.portfolioId),
          eq(schema.executionFills.mode, scope.mode),
          eq(schema.executionFills.side, "BUY"),
          gte(schema.executionFills.executedAt, since),
          inArray(
            schema.executionFills.intentId,
            dcaIntents.map((i) => i.intentId),
          ),
        ),
      );
    return dec(rows[0]?.total ?? "0");
  }

  // v1 fallback — amíg a v2 fill-ledger fel nem töltődik (T09/T11).
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${schema.trades.amountUsd}), 0)::text` })
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.side, "BUY"),
        eq(schema.trades.mode, scope.mode),
        eq(schema.trades.origin, "dca"),
        gte(schema.trades.executedAt, since),
      ),
    );
  return dec(rows[0]?.total ?? "0");
}

/** A még AKTÍV (beküldött, el nem számolt) DCA-foglalások összege ebben a hatókörben. */
export async function activeDcaReservationsUsd(
  scope: BudgetScope,
  dbOverride?: Db | null,
): Promise<Dec> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return ZERO;
  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${schema.budgetReservations.reservedQuote} - ${schema.budgetReservations.consumedQuote}), 0)::text`,
    })
    .from(schema.budgetReservations)
    .where(
      and(
        eq(schema.budgetReservations.portfolioId, scope.portfolioId),
        eq(schema.budgetReservations.mode, scope.mode),
        eq(schema.budgetReservations.origin, "dca"),
        eq(schema.budgetReservations.state, "active"),
      ),
    );
  return decMax(ZERO, dec(rows[0]?.total ?? "0"));
}

/**
 * Hátralévő heti keret quote-ban: `equity * dcaWeeklyBudgetPct − elköltött − foglalt`.
 * Sosem negatív. Lekérdezési hiba esetén konzervatívan 0 (mintha elfogyott volna).
 *
 * A `weeklyBudgetPct` a TÉNYLEGESEN futó stratégia paramétere (audit 5. pont). Enélkül a
 * függvény mindig a globális `PROFIT_CYCLE.dcaWeeklyBudgetPct`-et használta, így egy 20%-os
 * keretre konfigurált sáv (L2/L3) valójában 5%-kal futott: 320 USD equityn 16 USD keret a
 * szándékolt 64 helyett. Az alapérték változatlan, hogy a régi hívók viselkedése ne mozduljon.
 */
export async function remainingWeeklyBudget(
  totalEquity: Dec,
  scope: BudgetScope,
  nowMs: number = Date.now(),
  dbOverride?: Db | null,
  weeklyBudgetPct: number = PROFIT_CYCLE.dcaWeeklyBudgetPct,
): Promise<Dec> {
  const budget = mul(totalEquity, dec(weeklyBudgetPct));
  try {
    const spent = await spentThisWeekUsd(scope, nowMs, dbOverride);
    const reserved = await activeDcaReservationsUsd(scope, dbOverride);
    return decMax(ZERO, sub(sub(budget, spent), reserved));
  } catch (e) {
    console.error("[weekly-budget] lekérdezési hiba — konzervatívan 0 keret:", e);
    return ZERO;
  }
}

/** Tiszta segéd: a keret kiszámítása már ismert elköltött és foglalt összegekből. */
export function computeRemainingBudget(totalEquity: Dec, spent: Dec, reserved: Dec, weeklyPct: Dec): Dec {
  return decMax(ZERO, sub(sub(mul(totalEquity, weeklyPct), spent), reserved));
}

/** A keret elfogyása utáni maradék hozzáadása (teszt- és riport-segéd). */
export const addSpend = (spent: Dec, amount: Dec): Dec => add(spent, amount);

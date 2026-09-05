/**
 * Tartós végrehajtási állapot (T09) — EGY tranzakciós perzisztencia-út.
 *
 * A régi kód sorban, külön try/catch-ekben írt: pozíció, cash, majd trade. Egy részleges
 * hiba után az újrapróbálás duplázhatott, és a `console.error` utáni `null` visszatérés
 * SIKERNEK látszott (audit A. szakasz). Itt minden könyvelés EGY szerveroldali
 * függvényhívás (`apply_fill_v2`), tehát együtt commitol vagy együtt bukik, és a
 * `fill_key` egyedisége miatt a duplikált fill nem mozgat egyenleget.
 *
 * A hibák STRUKTURÁLTAK és DOBNAK: a hívó (execute-intent) nem tud véletlenül
 * „sikeresen" továbbmenni egy elveszett íráson.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, getSql, schema, type Db } from "@/db/client";
import { clientOrderId, type ExecutionIntent, type Fill, type TradingMode } from "@/lib/execution/contracts";
import type { ExecutionReceipt } from "@/lib/execution/broker";
import type { SqlDeltas } from "@/lib/portfolio/ledger";
import { emptyLedger, type LedgerState } from "@/lib/portfolio/ledger";
import { type Dec, ZERO, add, dec, sub, max as decMax } from "@/lib/portfolio/money";

export type PersistenceErrorCode =
  | "no_database"
  | "write_failed"
  | "reserve_failed"
  | "ledger_read_failed";

export class PersistenceError extends Error {
  constructor(
    readonly code: PersistenceErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

export interface LedgerScope {
  portfolioId: string;
  mode: TradingMode;
}

export interface ReservationSnapshot {
  bySymbol: Record<string, Dec>;
  total: Dec;
}

/** Egy foglalás alapértelmezett élettartama: ennyi idő után magától felszabadul. */
const RESERVATION_TTL_MS = 5 * 60 * 1000;

function requireDb(dbOverride?: Db | null): Db {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) throw new PersistenceError("no_database", "Nincs adatbázis-kapcsolat (DATABASE_URL hiányzik).");
  return db;
}

/**
 * A v2 ledger betöltése az adatbázisból. Ez az EGYETLEN igazságforrás a készpénzre,
 * a készletre és a bekerülési értékre.
 */
export async function loadLedgerState(
  scope: LedgerScope,
  quoteAsset = "USDT",
  dbOverride?: Db | null,
): Promise<LedgerState> {
  const db = requireDb(dbOverride);
  try {
    const cashRows = await db
      .select()
      .from(schema.ledgerCash)
      .where(and(eq(schema.ledgerCash.portfolioId, scope.portfolioId), eq(schema.ledgerCash.mode, scope.mode)));
    const positionRows = await db
      .select()
      .from(schema.ledgerPositions)
      .where(
        and(eq(schema.ledgerPositions.portfolioId, scope.portfolioId), eq(schema.ledgerPositions.mode, scope.mode)),
      );

    const state = emptyLedger(scope.portfolioId, scope.mode, ZERO, quoteAsset);
    for (const row of cashRows) state.cash[row.asset] = row.amount;
    for (const row of positionRows) {
      if (Number(row.qty) <= 0) continue;
      state.positions[row.symbol] = {
        symbol: row.symbol,
        qty: row.qty,
        costBasisQuote: row.costBasisQuote,
        stopPrice: row.stopPrice,
      };
    }
    return state;
  } catch (e) {
    throw new PersistenceError("ledger_read_failed", `A ledger nem olvasható: ${String(e)}`, e);
  }
}

/** Igaz, ha ebben a hatókörben már van v2 ledger-állapot (a T11 migráció után igen). */
export async function hasLedgerState(scope: LedgerScope, dbOverride?: Db | null): Promise<boolean> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return false;
  try {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.ledgerCash)
      .where(and(eq(schema.ledgerCash.portfolioId, scope.portfolioId), eq(schema.ledgerCash.mode, scope.mode)));
    return Number(row?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Az aktív foglalások pillanatképe a kockázati kapuhoz. */
export async function loadReservations(
  scope: LedgerScope,
  dbOverride?: Db | null,
): Promise<ReservationSnapshot> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return { bySymbol: {}, total: ZERO };
  try {
    const rows = await db
      .select()
      .from(schema.budgetReservations)
      .where(
        and(
          eq(schema.budgetReservations.portfolioId, scope.portfolioId),
          eq(schema.budgetReservations.mode, scope.mode),
          eq(schema.budgetReservations.state, "active"),
        ),
      );
    const bySymbol: Record<string, Dec> = {};
    let total: Dec = ZERO;
    for (const r of rows) {
      const open = decMax(ZERO, sub(r.reservedQuote, r.consumedQuote));
      bySymbol[r.symbol] = add(bySymbol[r.symbol] ?? ZERO, open);
      total = add(total, open);
    }
    return { bySymbol, total };
  } catch (e) {
    console.error("[order-store] loadReservations hiba:", e);
    return { bySymbol: {}, total: ZERO };
  }
}

/**
 * Keretfoglalás a beküldés ELŐTT. A döntést a SZERVER hozza: a beszúrás csak akkor
 * sikerül, ha az aktív foglalások és az új igény együtt beleférnek a fedezetbe. Így két
 * párhuzamos BUY nem lépheti át ugyanazt a keretet.
 */
export async function reserveBudget(
  intent: ExecutionIntent,
  quote: Dec,
  cashCap: Dec,
  ttlMs = RESERVATION_TTL_MS,
): Promise<boolean> {
  const raw = getSql();
  if (!raw) throw new PersistenceError("no_database", "Nincs adatbázis-kapcsolat a foglaláshoz.");
  try {
    const rows = (await raw`
      SELECT reserve_budget_v2(
        ${intent.intentId}, ${intent.portfolioId}, ${intent.mode}, ${intent.origin},
        ${intent.order.symbol}, ${quote}::numeric, ${cashCap}::numeric, ${ttlMs}::bigint
      ) AS r
    `) as { r: { reserved: boolean; reason: string } }[];
    return rows[0]?.r?.reserved === true;
  } catch (e) {
    throw new PersistenceError("reserve_failed", `A keretfoglalás nem sikerült: ${String(e)}`, e);
  }
}

/** A foglalás elengedése (elutasított vagy részlegesen teljesült order után). */
export async function releaseReservation(intentId: string): Promise<void> {
  const raw = getSql();
  if (!raw) return;
  try {
    await raw`SELECT release_budget_reservation(${intentId})`;
  } catch (e) {
    console.error("[order-store] releaseReservation hiba:", e);
  }
}

/** A lejárt foglalások takarítása (worker indulásakor és periodikusan). */
export async function expireStaleReservations(scope: LedgerScope): Promise<number> {
  const raw = getSql();
  if (!raw) return 0;
  try {
    const rows = (await raw`SELECT expire_stale_reservations(${scope.portfolioId}, ${scope.mode}) AS n`) as {
      n: number;
    }[];
    return Number(rows[0]?.n ?? 0);
  } catch (e) {
    console.error("[order-store] expireStaleReservations hiba:", e);
    return 0;
  }
}

/** Az intent és az aktuális order-állapot naplózása. Egyedi az intentId-n. */
export async function recordIntent(
  intent: ExecutionIntent,
  receipt: ExecutionReceipt | null,
  dbOverride?: Db | null,
): Promise<void> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return;
  try {
    await db
      .insert(schema.executionIntents)
      .values({
        intentId: intent.intentId,
        portfolioId: intent.portfolioId,
        mode: intent.mode,
        strategyVersion: intent.strategyVersion,
        origin: intent.origin,
        symbol: intent.order.symbol,
        side: intent.order.side,
        maxQuoteSpend: intent.order.side === "BUY" ? intent.order.maxQuoteSpend : null,
        baseQty: intent.order.side === "SELL" ? intent.order.baseQty : null,
        referencePrice: intent.referencePrice,
        expiresAt: new Date(intent.expiresAt),
        state: receipt?.state ?? "unknown",
        clientOrderId: clientOrderId(intent.intentId),
        exchangeOrderId: receipt?.exchangeOrderId ?? null,
        lastError: receipt?.error ?? null,
      })
      .onConflictDoUpdate({
        target: schema.executionIntents.intentId,
        set: {
          state: receipt?.state ?? "unknown",
          exchangeOrderId: receipt?.exchangeOrderId ?? null,
          lastError: receipt?.error ?? null,
          updatedAt: new Date(),
        },
      });
  } catch (e) {
    // Az intent-napló elvesztése nem teheti tönkre a könyvelést, de hangosan látszik.
    console.error("[order-store] recordIntent hiba:", e);
  }
}

export interface ApplyFillOutcome {
  applied: boolean;
  reason?: string;
}

/**
 * EGY teljesülés tartós könyvelése: fill + cash + pozíció + foglalás EGYÜTT, egyetlen
 * szerveroldali tranzakcióban. Duplikált `fill_key` esetén `applied: false` — nincs
 * második egyenleg-mozgás. Bármely más hiba DOBÁSSAL jelentkezik.
 */
export async function persistFill(
  intent: ExecutionIntent,
  fill: Fill,
  deltas: SqlDeltas,
): Promise<ApplyFillOutcome> {
  const raw = getSql();
  if (!raw) throw new PersistenceError("no_database", "Nincs adatbázis-kapcsolat a fill könyveléséhez.");
  const fillPayload = {
    fillId: fill.fillId,
    intentId: fill.intentId,
    portfolioId: fill.portfolioId,
    mode: fill.mode,
    symbol: fill.symbol,
    side: fill.side,
    exchangeOrderId: fill.exchangeOrderId,
    exchangeTradeId: fill.exchangeTradeId,
    filledBaseQty: fill.filledBaseQty,
    grossQuoteAmount: fill.grossQuoteAmount,
    fillPrice: fill.fillPrice,
    feeAmount: fill.feeAmount,
    feeAsset: fill.feeAsset,
    executedAt: fill.executedAt,
    provenance: "live-v2",
  };
  try {
    const rows = (await raw`
      SELECT apply_fill_v2(${JSON.stringify(fillPayload)}::jsonb, ${JSON.stringify(deltas)}::jsonb) AS r
    `) as { r: { applied: boolean; reason?: string } }[];
    const result = rows[0]?.r;
    if (!result) throw new Error("Az apply_fill_v2 nem adott vissza eredményt");
    return { applied: result.applied === true, reason: result.reason };
  } catch (e) {
    throw new PersistenceError(
      "write_failed",
      `A teljesülés könyvelése nem sikerült (intent ${intent.intentId}, fill ${fill.fillId}): ${String(e)}`,
      e,
    );
  }
}

/** A pozíció stop-ára a v2 ledgerben (a trailing ratchet írja). Sosem viszi lejjebb. */
export async function persistStopPrice(
  scope: LedgerScope,
  symbol: string,
  stopPrice: Dec,
  dbOverride?: Db | null,
): Promise<boolean> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return false;
  try {
    await db
      .update(schema.ledgerPositions)
      .set({ stopPrice, updatedAt: new Date() })
      .where(
        and(
          eq(schema.ledgerPositions.portfolioId, scope.portfolioId),
          eq(schema.ledgerPositions.mode, scope.mode),
          eq(schema.ledgerPositions.symbol, symbol),
          // Csak felfelé: a ratchet sosem csökkenti a védelmet.
          sql`(${schema.ledgerPositions.stopPrice} IS NULL OR ${schema.ledgerPositions.stopPrice} < ${stopPrice}::numeric)`,
        ),
      );
    return true;
  } catch (e) {
    console.error("[order-store] persistStopPrice hiba:", e);
    return false;
  }
}

/** A még nyitott (pending vagy ismeretlen állapotú) intentek — az egyeztetés bemenete. */
export async function listUnsettledIntents(
  scope: LedgerScope,
  dbOverride?: Db | null,
): Promise<
  { intentId: string; symbol: string; side: string; state: string; clientOrderId: string; exchangeOrderId: string | null }[]
> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return [];
  try {
    const rows = await db
      .select()
      .from(schema.executionIntents)
      .where(
        and(
          eq(schema.executionIntents.portfolioId, scope.portfolioId),
          eq(schema.executionIntents.mode, scope.mode),
          inArray(schema.executionIntents.state, ["pending", "partially_filled", "unknown"]),
        ),
      );
    return rows.map((r) => ({
      intentId: r.intentId,
      symbol: r.symbol,
      side: r.side,
      state: r.state,
      clientOrderId: r.clientOrderId,
      exchangeOrderId: r.exchangeOrderId,
    }));
  } catch (e) {
    console.error("[order-store] listUnsettledIntents hiba:", e);
    return [];
  }
}

/** A ledger nyitóállapotának felvétele (T11 epoch, illetve első inicializálás). */
export async function seedLedger(
  scope: LedgerScope,
  openingCash: Dec,
  positions: { symbol: string; qty: Dec; costBasisQuote: Dec; stopPrice: Dec | null }[],
  quoteAsset = "USDT",
  dbOverride?: Db | null,
): Promise<void> {
  const db = requireDb(dbOverride);
  await db
    .insert(schema.ledgerCash)
    .values({ portfolioId: scope.portfolioId, mode: scope.mode, asset: quoteAsset, amount: openingCash })
    .onConflictDoNothing();
  for (const p of positions) {
    await db
      .insert(schema.ledgerPositions)
      .values({
        portfolioId: scope.portfolioId,
        mode: scope.mode,
        symbol: p.symbol,
        qty: p.qty,
        costBasisQuote: p.costBasisQuote,
        stopPrice: p.stopPrice,
      })
      .onConflictDoNothing();
  }
}

/** Kényelmi átváltás: number → Dec a régi hívási helyeknek. */
export const toDec = dec;

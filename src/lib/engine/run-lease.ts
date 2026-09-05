/**
 * Futási lease és fencing (T10).
 *
 * A régi idempotencia „előbb SELECT a decisions táblán, később INSERT" volt. Két
 * egyidejű futó (Vercel cron + GitHub runner, vagy két worker) MINDKETTŐ üresnek
 * láthatta a táblát, és mindkettő kereskedett. A tick id önmagában nem zár ki senkit.
 *
 * Itt tartós CLAIM van: az `acquire_run_lease` SQL-függvény egyetlen tranzakcióban
 * dönt, és monoton `fencingToken`-t ad. A token a késve ébredő régi tulajdonos írásait
 * teszi felismerhetővé — ha a token elavult, az írás elutasítható.
 *
 * A lease KULCSA idősávonként külön van (belépés és kilépés), hogy a gyors exit-ciklus
 * ne zárja ki az órás belépést és fordítva.
 */
import { getSql } from "@/db/client";

export type RunKind = "entry" | "exit" | "reconcile";

export interface Lease {
  key: string;
  owner: string;
  fencingToken: number;
  expiresAtMs: number;
  acquired: boolean;
  /** Ha nem mi nyertük: ki tartja a lease-t. */
  heldBy?: string;
}

/** Egy futó egyedi azonosítója (folyamat + véletlen). Naplóban is látszik. */
export function newOwnerId(prefix = "runner"): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const pid = typeof process !== "undefined" && process.pid ? process.pid : 0;
  return `${prefix}-${pid}-${rand}`;
}

/** Az adott idősáv azonosítója: a `now` melyik `intervalMs` hosszú sávba esik (UTC). */
export function slotId(nowMs: number, intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("slotId: pozitív intervalMs kell");
  return String(Math.floor(nowMs / intervalMs) * intervalMs);
}

/** A lease kulcsa: a fajta és az idősáv EGYÜTT — a belépés és a kilépés nem zárja ki egymást. */
export function leaseKey(kind: RunKind, slot: string): string {
  return `${kind}:${slot}`;
}

/**
 * Lease megszerzése vagy megújítása. Ugyanaz a tulajdonos MEGÚJÍT (a token nem nő), más
 * tulajdonos csak lejárat után vehet át (és akkor nő a token).
 *
 * DB nélkül `acquired: false` — kereskedés kizárólag megszerzett lease-szel indulhat.
 */
export async function acquireLease(key: string, owner: string, ttlMs: number): Promise<Lease> {
  const sql = getSql();
  if (!sql) {
    return { key, owner, fencingToken: 0, expiresAtMs: 0, acquired: false, heldBy: undefined };
  }
  try {
    const rows = (await sql`SELECT acquire_run_lease(${key}, ${owner}, ${ttlMs}::bigint) AS r`) as {
      r: { acquired: boolean; owner: string; fencingToken: number; expiresAt: number };
    }[];
    const r = rows[0]?.r;
    if (!r) return { key, owner, fencingToken: 0, expiresAtMs: 0, acquired: false };
    return {
      key,
      owner,
      fencingToken: Number(r.fencingToken),
      expiresAtMs: Number(r.expiresAt),
      acquired: r.acquired === true,
      heldBy: r.owner,
    };
  } catch (e) {
    console.error("[run-lease] acquireLease hiba:", e);
    return { key, owner, fencingToken: 0, expiresAtMs: 0, acquired: false };
  }
}

/** A lease elengedése. CSAK a tulajdonos engedheti el. */
export async function releaseLease(key: string, owner: string): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    const rows = (await sql`SELECT release_run_lease(${key}, ${owner}) AS ok`) as { ok: boolean }[];
    return rows[0]?.ok === true;
  } catch (e) {
    console.error("[run-lease] releaseLease hiba:", e);
    return false;
  }
}

export interface WithLeaseResult<T> {
  ran: boolean;
  lease: Lease;
  result?: T;
  /** Igaz, ha azért nem futottunk, mert MÁS tartja a lease-t. */
  skippedBecauseHeld: boolean;
}

/**
 * A megadott munkát CSAK akkor futtatja, ha megszereztük a lease-t.
 *
 * SIKER esetén a lease BENT MARAD a lejáratáig: ez a tartós claim, ami az adott idősáv
 * ismételt feldolgozását megakadályozza. HIBA esetén elengedjük, hogy egy újrapróbálás
 * ugyanabban a sávban még dolgozhasson — a részleges könyvelést a fill-egyediség védi.
 */
export async function withLease<T>(
  key: string,
  owner: string,
  ttlMs: number,
  work: (lease: Lease) => Promise<T>,
): Promise<WithLeaseResult<T>> {
  const lease = await acquireLease(key, owner, ttlMs);
  if (!lease.acquired) {
    return { ran: false, lease, skippedBecauseHeld: true };
  }
  try {
    const result = await work(lease);
    return { ran: true, lease, result, skippedBecauseHeld: false };
  } catch (e) {
    await releaseLease(key, owner);
    throw e;
  }
}

/**
 * Igaz, ha a megadott token MÁR ELAVULT az aktuális lease-hez képest. A hosszú hálózati
 * hívás után visszatérő régi futó ezzel ismeri fel, hogy közben kifencelték.
 */
export async function isFenced(key: string, token: number): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  try {
    const rows = (await sql`SELECT fencing_token FROM run_leases WHERE lease_key = ${key}`) as {
      fencing_token: number;
    }[];
    if (rows.length === 0) return false;
    return Number(rows[0].fencing_token) > token;
  } catch (e) {
    console.error("[run-lease] isFenced hiba:", e);
    return false;
  }
}

/** Alapértelmezett idősáv-hosszok: órás belépés, 5 perces kilépés. */
export const SLOT_MS = {
  entry: 60 * 60 * 1000,
  exit: 5 * 60 * 1000,
  reconcile: 15 * 60 * 1000,
} as const;

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import * as schema from "@/db/schema";

/**
 * Integrációs teszt-segédek. CSAK a teszt-DB ellen futnak: a setup.ts már ellenőrizte,
 * hogy a DATABASE_URL a TEST_DATABASE_URL-re mutat, és nem az élesre.
 */

export function testSql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[integration] DATABASE_URL nincs beállítva (setup.ts hiba)");
  return neon(url, { fetchOptions: { cache: "no-store" } });
}

export function testDb() {
  return drizzle(testSql(), { schema });
}

/** A repó migrációit alkalmazza a teszt-DB-re (idempotens: a drizzle nyilvántartja). */
export async function applyMigrations(): Promise<void> {
  await migrate(testDb(), { migrationsFolder: "src/db/migrations" });
}

/** Teljesen tiszta lap: minden alkalmazás-tábla eldobása, majd újramigrálás. */
export async function resetSchema(): Promise<void> {
  const sql = testSql();
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await applyMigrations();
}

/** Csak az adat törlése (a séma marad) — gyorsabb a tesztek között. */
export async function truncateAll(): Promise<void> {
  const sql = testSql();
  await sql`
    TRUNCATE TABLE
      execution_fills, execution_intents, budget_reservations, ledger_cash,
      ledger_positions, daily_equity, run_leases, ledger_epochs,
      trades, positions, portfolios, decisions, risk_overrides, tick_runs,
      raw_events, ml_signals, backtests, settings
    RESTART IDENTITY CASCADE
  `;
}

/** Igaz, ha a megnevezett tábla létezik a public sémában. */
export async function tableExists(name: string): Promise<boolean> {
  const sql = testSql();
  const rows = (await sql`
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${name}
  `) as unknown[];
  return rows.length > 0;
}

/** Egy oszlop adattípusa (pl. "numeric", "real") — a numeric-átállás bizonyítéka. */
export async function columnType(table: string, column: string): Promise<string | null> {
  const sql = testSql();
  const rows = (await sql`
    SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `) as { data_type: string }[];
  return rows[0]?.data_type ?? null;
}

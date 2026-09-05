/**
 * audit-state — CSAK OLVASÓ állapot-export a mérési alaphoz (T01).
 *
 * Futtatás:  pnpm audit:state            → összefoglaló a konzolra
 *            pnpm audit:state --out FILE → JSON fájlba is (audit-exports/ gitignore-olt)
 *
 * Szabályok:
 *  - SOHA nem ír az adatbázisba (csak SELECT), nem indít kereskedést, nem módosít configot.
 *  - A kimenet REDAKTÁLT: se DB-URL, se API-kulcs, se host/felhasználónév nem kerül bele.
 *  - A pénzügyi export nem mehet gitbe: az alapértelmezett cél az audit-exports/ mappa,
 *    amit a .gitignore kizár.
 *
 * A jelentés-építés tiszta függvény (buildAuditReport) — fixture-adaton tesztelhető.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config();

/** Nyers, DB-ből olvasott állapot (a tiszta jelentés-építő bemenete). */
export interface AuditRawState {
  portfolios: { id: string; initialCapitalUsd: number; cashUsd: number; mode: string; createdAt: string }[];
  openPositions: { symbol: string; qty: number; entryPrice: number; stopPrice: number }[];
  trades: { side: string; origin: string | null; mode: string; amountUsd: number; feeUsd: number; executedAt: string }[];
  decisionCount: number;
  lastDecisionTs: string | null;
  tickRunCount: number;
}

export interface AuditReport {
  generatedAtIso: string;
  portfolios: { idPrefix: string; initialCapitalUsd: number; cashUsd: number; mode: string }[];
  openPositions: { symbol: string; qty: number; entryPrice: number; stopPrice: number; valueAtEntryUsd: number }[];
  trades: {
    total: number;
    buys: number;
    sells: number;
    byOrigin: Record<string, number>;
    byMode: Record<string, number>;
    grossBuyUsd: number;
    grossSellUsd: number;
    feesUsd: number;
    firstExecutedAt: string | null;
    lastExecutedAt: string | null;
  };
  decisions: { total: number; lastTs: string | null };
  tickRuns: number;
  /** Amit az export SZÁNDÉKOSAN nem tartalmaz (átláthatóság). */
  redacted: string[];
}

const countBy = <T>(rows: T[], key: (r: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

/** Tiszta: nyers állapot → redaktált jelentés. Nincs IO, nincs Date.now (injektált idő). */
export function buildAuditReport(state: AuditRawState, nowIso: string): AuditReport {
  const buys = state.trades.filter((t) => t.side === "BUY");
  const sells = state.trades.filter((t) => t.side === "SELL");
  const times = state.trades.map((t) => t.executedAt).sort();
  return {
    generatedAtIso: nowIso,
    portfolios: state.portfolios.map((p) => ({
      // Csak az id ELEJE — a teljes uuid nem szükséges az audithoz.
      idPrefix: p.id.slice(0, 8),
      initialCapitalUsd: p.initialCapitalUsd,
      cashUsd: p.cashUsd,
      mode: p.mode,
    })),
    openPositions: state.openPositions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      entryPrice: p.entryPrice,
      stopPrice: p.stopPrice,
      valueAtEntryUsd: p.qty * p.entryPrice,
    })),
    trades: {
      total: state.trades.length,
      buys: buys.length,
      sells: sells.length,
      byOrigin: countBy(state.trades, (t) => t.origin ?? "unknown"),
      byMode: countBy(state.trades, (t) => t.mode),
      grossBuyUsd: buys.reduce((s, t) => s + t.amountUsd, 0),
      grossSellUsd: sells.reduce((s, t) => s + t.amountUsd, 0),
      feesUsd: state.trades.reduce((s, t) => s + t.feeUsd, 0),
      firstExecutedAt: times[0] ?? null,
      lastExecutedAt: times[times.length - 1] ?? null,
    },
    decisions: { total: state.decisionCount, lastTs: state.lastDecisionTs },
    tickRuns: state.tickRunCount,
    redacted: [
      "DATABASE_URL / DB host / felhasználónév",
      "API kulcsok (LLM, Binance, Reddit, CryptoPanic, WhaleAlert)",
      "teljes portfolio/position/trade UUID-k",
      "LLM prompt- és válasz-szövegek",
    ],
  };
}

/** CSAK SELECT — a script sosem ír. */
async function readState(): Promise<AuditRawState> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL hiányzik — az audit-state csak olvasni tud, de kell kapcsolat.");
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  const portfolios = (await sql`
    SELECT id, initial_capital_usd, cash_usd, mode, created_at FROM portfolios ORDER BY created_at
  `) as Record<string, unknown>[];
  const openPositions = (await sql`
    SELECT symbol, qty, entry_price, stop_price FROM positions WHERE closed_at IS NULL ORDER BY symbol
  `) as Record<string, unknown>[];
  const trades = (await sql`
    SELECT side, origin, mode, amount_usd, fee_usd, executed_at FROM trades ORDER BY executed_at
  `) as Record<string, unknown>[];
  const [{ c: decisionCount }] = (await sql`SELECT count(*)::int AS c FROM decisions`) as { c: number }[];
  const lastDecision = (await sql`SELECT ts FROM decisions ORDER BY ts DESC LIMIT 1`) as { ts: string }[];
  const [{ c: tickRunCount }] = (await sql`SELECT count(*)::int AS c FROM tick_runs`) as { c: number }[];

  return {
    portfolios: portfolios.map((p) => ({
      id: String(p.id),
      initialCapitalUsd: Number(p.initial_capital_usd),
      cashUsd: Number(p.cash_usd),
      mode: String(p.mode),
      createdAt: new Date(p.created_at as string).toISOString(),
    })),
    openPositions: openPositions.map((p) => ({
      symbol: String(p.symbol),
      qty: Number(p.qty),
      entryPrice: Number(p.entry_price),
      stopPrice: Number(p.stop_price),
    })),
    trades: trades.map((t) => ({
      side: String(t.side),
      origin: t.origin === null ? null : String(t.origin),
      mode: String(t.mode),
      amountUsd: Number(t.amount_usd),
      feeUsd: Number(t.fee_usd),
      executedAt: new Date(t.executed_at as string).toISOString(),
    })),
    decisionCount,
    lastDecisionTs: lastDecision[0] ? new Date(lastDecision[0].ts).toISOString() : null,
    tickRunCount,
  };
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;

  const report = buildAuditReport(await readState(), new Date().toISOString());
  console.log(JSON.stringify(report, null, 2));

  if (outPath) {
    const { writeFile, mkdir } = await import("fs/promises");
    const { dirname } = await import("path");
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    console.error(`\n[audit-state] Kiírva: ${outPath} (pénzügyi adat — NE commitold)`);
  }
}

// Csak közvetlen futtatáskor indul (importáláskor — teszt — nem).
if (process.argv[1] && process.argv[1].includes("audit-state")) {
  main().catch((e) => {
    console.error("[audit-state] hiba:", e);
    process.exit(1);
  });
}

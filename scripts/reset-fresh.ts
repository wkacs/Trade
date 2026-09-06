/**
 * Friss paper mérési lap: a v1 és v2 kereskedési állapotot együtt nullázza, majd
 * új USDT nyitóegyenleget és ledger epochot hoz létre.
 *
 * Futtatás:
 *   pnpm tsx scripts/reset-fresh.ts --huf 100000 --huf-per-usd 312.78
 *   pnpm tsx scripts/reset-fresh.ts --usd 319.71353667
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { quoteCapitalFromHuf } from "@/lib/portfolio/reset-capital";

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const huf = arg("huf");
const hufPerUsd = arg("huf-per-usd");
const usd = arg("usd");
if ((!usd && (!huf || !hufPerUsd)) || (usd && (huf || hufPerUsd))) {
  throw new Error("Adj meg vagy --usd értéket, vagy együtt a --huf és --huf-per-usd értékeket.");
}
const capital = usd ? Number(usd) : Number(quoteCapitalFromHuf(Number(huf), Number(hufPerUsd)));
if (!Number.isFinite(capital) || capital <= 0) throw new Error("A kezdőtőkének pozitív számnak kell lennie.");
const capitalText = capital.toFixed(8);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ DATABASE_URL hiányzik");
    process.exit(1);
  }
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  let existing = await sql`SELECT id FROM portfolios ORDER BY created_at LIMIT 2`;
  if (existing.length > 1) throw new Error("Több portfólió van az adatbázisban; az automatikus reset nem egyértelmű.");
  if (existing.length === 0) {
    existing = await sql`INSERT INTO portfolios (initial_capital_usd, cash_usd, mode)
      VALUES (${capital}, ${capital}, 'paper') RETURNING id`;
  }
  const portfolioId = String(existing[0].id);

  const [liveState] = await sql`SELECT
    (SELECT count(*)::int FROM ledger_cash WHERE portfolio_id = ${portfolioId} AND mode = 'live') +
    (SELECT count(*)::int FROM execution_intents WHERE portfolio_id = ${portfolioId} AND mode = 'live') +
    (SELECT count(*)::int FROM bot_protection_orders WHERE portfolio_id = ${portfolioId}) AS count`;
  if (Number(liveState.count) > 0) {
    throw new Error("Live ledger/order állapot található; a paper reset biztonsági okból leállt.");
  }

  const epochVersion = `paper-reset-${new Date().toISOString()}`;
  await sql.transaction((tx) => [
    tx`DELETE FROM budget_reservations WHERE portfolio_id = ${portfolioId} AND mode = 'paper'`,
    tx`DELETE FROM execution_fills WHERE portfolio_id = ${portfolioId} AND mode = 'paper'`,
    tx`DELETE FROM execution_intents WHERE portfolio_id = ${portfolioId} AND mode = 'paper'`,
    tx`DELETE FROM ledger_positions WHERE portfolio_id = ${portfolioId} AND mode = 'paper'`,
    tx`DELETE FROM ledger_cash WHERE portfolio_id = ${portfolioId} AND mode = 'paper'`,
    tx`DELETE FROM ledger_epochs WHERE portfolio_id = ${portfolioId} AND mode = 'paper'`,
    tx`DELETE FROM daily_equity WHERE portfolio_id = ${portfolioId} AND mode = 'paper'`,
    tx`DELETE FROM run_leases`,
    tx`DELETE FROM risk_overrides`,
    tx`DELETE FROM decisions`,
    tx`DELETE FROM tick_runs`,
    tx`DELETE FROM trades`,
    tx`DELETE FROM positions`,
    tx`UPDATE portfolios SET initial_capital_usd = ${capital}, cash_usd = ${capital}, mode = 'paper'
       WHERE id = ${portfolioId}::uuid`,
    tx`INSERT INTO ledger_cash (portfolio_id, mode, asset, amount)
       VALUES (${portfolioId}, 'paper', 'USDT', ${capitalText})`,
    tx`INSERT INTO ledger_epochs
       (portfolio_id, mode, epoch_version, started_at, opening_cash_quote, opening_positions, note)
       VALUES (${portfolioId}, 'paper', ${epochVersion}, now(), ${capitalText}, '[]'::jsonb,
         ${huf ? `${huf} HUF @ ${hufPerUsd} HUF/USD` : `${capitalText} USD reset`})`,
  ]);

  const [p] = await sql`SELECT initial_capital_usd, cash_usd, mode FROM portfolios WHERE id = ${portfolioId}::uuid`;
  const [lc] = await sql`SELECT amount FROM ledger_cash
    WHERE portfolio_id = ${portfolioId} AND mode = 'paper' AND asset = 'USDT'`;
  const dc = await sql`SELECT count(*)::int c FROM decisions`;
  const tr = await sql`SELECT count(*)::int c FROM trades`;
  const ps = await sql`SELECT count(*)::int c FROM positions`;
  console.log("🧹 Friss lap kész:");
  console.log(`   portfólió: $${p.initial_capital_usd} kezdőtőke / $${p.cash_usd} cash / ${p.mode}`);
  console.log(`   v2 ledger: ${lc.amount} USDT`);
  if (huf) console.log(`   forint keret: ${huf} Ft @ ${hufPerUsd} Ft/USD`);
  console.log(`   decisions: ${dc[0].c}, trades: ${tr[0].c}, positions: ${ps[0].c}`);
}

main().catch((e) => {
  console.error("❌ Hiba:", e);
  process.exit(1);
});

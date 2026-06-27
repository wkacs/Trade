/**
 * Friss lap: töröl minden trade/pozíció/döntés-előzményt, és a portfóliót ÚJ
 * kezdőtőkével állítja be (default $100). Paper mód.
 * Futtatás: pnpm tsx scripts/reset-fresh.ts [tőke]   pl. pnpm tsx scripts/reset-fresh.ts 100
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

const CAPITAL = Number(process.argv[2] ?? 100);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ DATABASE_URL hiányzik");
    process.exit(1);
  }
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  // Előzmény törlése (a kapcsolt sorok miatt sorrend: risk_overrides → decisions, trades → positions).
  await sql`DELETE FROM risk_overrides`;
  await sql`DELETE FROM decisions`;
  await sql`DELETE FROM trades`;
  await sql`DELETE FROM positions`;

  // Portfólió friss kezdőtőkével. Ha van sor → frissít; ha nincs → beszúr.
  const existing = await sql`SELECT id FROM portfolios LIMIT 1`;
  if (existing.length > 0) {
    await sql`UPDATE portfolios SET initial_capital_usd = ${CAPITAL}, cash_usd = ${CAPITAL}, mode = 'paper'`;
  } else {
    await sql`INSERT INTO portfolios (initial_capital_usd, cash_usd, mode) VALUES (${CAPITAL}, ${CAPITAL}, 'paper')`;
  }

  const [p] = await sql`SELECT initial_capital_usd, cash_usd, mode FROM portfolios LIMIT 1`;
  const dc = await sql`SELECT count(*)::int c FROM decisions`;
  const tr = await sql`SELECT count(*)::int c FROM trades`;
  const ps = await sql`SELECT count(*)::int c FROM positions`;
  console.log("🧹 Friss lap kész:");
  console.log(`   portfólió: $${p.initial_capital_usd} kezdőtőke / $${p.cash_usd} cash / ${p.mode}`);
  console.log(`   decisions: ${dc[0].c}, trades: ${tr[0].c}, positions: ${ps[0].c}`);
}

main().catch((e) => {
  console.error("❌ Hiba:", e);
  process.exit(1);
});

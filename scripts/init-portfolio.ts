/**
 * Portfólió inicializálása kezdőtőkével. Lásd spec §1.
 * Futtatás: pnpm tsx scripts/init-portfolio.ts
 *
 * Alapértelmezett: $27 (~10 000 Ft), paper (demo) módban.
 * Argumentummal felülírható: pnpm tsx scripts/init-portfolio.ts 1000
 */
import "dotenv/config";

const INITIAL_CAPITAL_USD = Number(process.argv[2] ?? 27);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ DATABASE_URL hiányzik a .env / .env.local-ből");
    process.exit(1);
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  // Ellenőrizzük, van-e már portfólió
  const existing = await sql`SELECT id, cash_usd, mode FROM portfolios LIMIT 1`;

  if (existing.length > 0) {
    console.log(
      `⚠ Már létezik portfólió: id=${existing[0].id}, cash=$${existing[0].cash_usd}, mode=${existing[0].mode}`,
    );
    console.log("Ha újat szeretnél, előbb töröld: TRUNCATE portfolios CASCADE;");
    process.exit(0);
  }

  // Új portfólió
  const [row] = await sql`
    INSERT INTO portfolios (initial_capital_usd, cash_usd, mode)
    VALUES (${INITIAL_CAPITAL_USD}, ${INITIAL_CAPITAL_USD}, 'paper')
    RETURNING id, cash_usd, mode, created_at
  `;

  console.log(`✅ Portfólió inicializálva:`);
  console.log(`   ID:            ${row.id}`);
  console.log(`   Kezdőtőke:     $${row.cash_usd}`);
  console.log(`   Mód:           ${row.mode} (demo)`);
  console.log(`   Létrehozva:    ${row.created_at}`);
  console.log(`\n💰 A demo kereskedés indulhat!`);
}

main().catch((e) => {
  console.error("❌ Hiba:", e);
  process.exit(1);
});

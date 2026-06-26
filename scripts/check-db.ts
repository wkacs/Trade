/**
 * Ideiglenes diagnosztikai script: ellenőrzi, hogy a Neon DB kapcsolat
 * és a táblák létrejöttek-e. Futtatás: pnpm tsx scripts/check-db.ts
 */
import "dotenv/config";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ DATABASE_URL hiányzik");
    process.exit(1);
  }
  console.log("✓ DATABASE_URL betöltve");

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  try {
    // Táblák listázása
    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;
    console.log(`\n📋 Táblák a '${url.split("@")[1]?.split("/")[0]}' adatbázisban (${tables.length}):`);
    for (const t of tables) {
      console.log(`   - ${t.tablename}`);
    }

    // Soroszámok
    const expected = [
      "raw_events", "ml_signals", "portfolios", "positions", "trades",
      "decisions", "risk_overrides", "backtests", "settings",
    ];
    const found = tables.map((t) => t.tablename);
    const missing = expected.filter((e) => !found.includes(e));
    if (missing.length === 0) {
      console.log("\n✅ Mind a 9 tábla létrejött — adatbázis kész!");
    } else {
      console.log(`\n⚠ Hiányzó táblák: ${missing.join(", ")}`);
    }
  } catch (e) {
    console.error("❌ Kapcsolat/query hiba:", e);
    process.exit(1);
  }
}

main();

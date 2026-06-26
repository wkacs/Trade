/**
 * Demo adatok törlése — tisztázás egy új teszt előtt.
 * Futtatás: pnpm tsx scripts/reset-demo.ts
 */
import "dotenv/config";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ DATABASE_URL hiányzik");
    process.exit(1);
  }
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  await sql`DELETE FROM decisions`;
  await sql`DELETE FROM trades`;
  await sql`DELETE FROM risk_overrides`;
  await sql`DELETE FROM positions`;

  const d = await sql`SELECT count(*)::int AS c FROM decisions`;
  const t = await sql`SELECT count(*)::int AS c FROM trades`;
  console.log(`🧹 Törölve. decisions: ${d[0].c}, trades: ${t[0].c}`);
  console.log("A portfólió (cash) érintetlen maradt.");
}

main().catch((e) => {
  console.error("❌ Hiba:", e);
  process.exit(1);
});

/**
 * Diagnosztika: miért HOLD-ol folyton a rendszer?
 * Megmutatja a döntések eloszlását (HOLD vs BUY/SELL) és a reasoning-eket.
 * Futtatás: pnpm tsx scripts/diagnose-decisions.ts
 */
import "dotenv/config";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("NINCS DATABASE_URL — nem lehet lekérdezni a döntéseket.");
    process.exit(0);
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);

  // 1) Döntések eloszlása action-onként
  const counts = (await sql`
    SELECT action, count(*)::int AS c
    FROM decisions GROUP BY action ORDER BY action
  `) as { action: string; c: number }[];
  console.log("\n=== Döntések eloszlása ===");
  for (const r of counts) console.log(`  ${r.action}: ${r.c}`);

  const total = (await sql`SELECT count(*)::int AS c FROM decisions`) as {
    c: number;
  }[];
  console.log(`Összesen: ${total[0].c}`);

  // 2) Phase-1 (shouldDecide) nyoma: a reasoning-ben látszik, mit mondott a phase-1
  //    A HOLD-ok általában a phase-1 summary-jei ("csendes óra" stb.).
  console.log("\n=== Utolsó 12 döntés ===");
  const recent = (await sql`
    SELECT action, symbol, confidence, tick_id, reasoning
    FROM decisions ORDER BY ts DESC LIMIT 12
  `) as {
    action: string;
    symbol: string | null;
    confidence: number;
    tick_id: string;
    reasoning: string;
  }[];
  for (const d of recent) {
    const model = d.action === "HOLD" && d.symbol === null ? "phase1" : "phase2";
    console.log(
      `[${d.tick_id}] ${d.action.padEnd(4)} conf=${Number(d.confidence).toFixed(
        2,
      )} (${model}) | ${(d.reasoning ?? "").slice(0, 85)}`,
    );
  }

  // 3) Phase-1 hány %-ban mondott "ne dönts"? (= HOLD symbol-null)
  const phase1Holds = (await sql`
    SELECT count(*)::int AS c FROM decisions WHERE action='HOLD' AND symbol IS NULL
  `) as { c: number }[];
  const actionable = (await sql`
    SELECT count(*)::int AS c FROM decisions WHERE action IN ('BUY','SELL') OR (action='HOLD' AND symbol IS NOT NULL)
  `) as { c: number }[];
  console.log(
    `\n=== Szűk keresztmetszet ===\n  Phase-1 'ne dönts' (HOLD, nincs symbol): ${phase1Holds[0].c}\n  Phase-2-hez jutott (volt symbol/action): ${actionable[0].c}`,
  );

  // 4) Volt egyáltalán valaha trade?
  const trades = (await sql`SELECT count(*)::int AS c FROM trades`) as {
    c: number;
  }[];
  console.log(`\nFizikai tradék száma: ${trades[0].c}`);
}

main().catch((e) => {
  console.error("Hiba:", e);
  process.exit(1);
});

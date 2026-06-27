/**
 * Ütemezett tick a GitHub-runnerben (vagy lokálisan) — NINCS Vercel 60s limit.
 *
 * Futtatás:  pnpm tsx scripts/tick.ts
 * Env:       lokálisan a .env.local-ből (fallback .env); CI-ben a GitHub secrets a
 *            process.env-ben (a dotenv NEM írja felül a már beállított változókat).
 *
 * Ugyanazt az executeScheduledTick()-et hívja, mint a Vercel /api/cron/tick route,
 * így a logika egy forrás. Nem-nulla exit kód, ha a tick hibázott (a workflow piros lesz).
 */
import { config } from "dotenv";

// Env betöltés MINDEN más import előtt — a getDb() lustán olvassa a DATABASE_URL-t,
// de a config.ts és társai betöltéskor olvashatnak env-et, ezért előbb töltünk.
config({ path: ".env.local" });
config(); // .env fallback (a már beállított kulcsokat nem írja felül)

async function main() {
  const { executeScheduledTick } = await import("@/lib/engine/run-scheduled-tick");
  const result = await executeScheduledTick();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error("[scripts/tick] végzetes hiba:", e);
  process.exit(1);
});

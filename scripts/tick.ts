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

/** `--force`: akkor is fut, ha nem ez az aktív ütemező (kézi, egyszeri futtatás). */
const FORCE = process.argv.includes("--force");

async function main() {
  const { schedulerGuard } = await import("@/lib/config");
  const guard = schedulerGuard("github-actions");
  if (!guard.active && !FORCE) {
    // NEM hiba: a workflow zölden kihagyja. Így a workflow bekapcsolva maradhat
    // anélkül, hogy a workerrel párhuzamosan tickelne.
    console.log(`[scripts/tick] KIHAGYVA — ${guard.message} (kézi futtatás: --force)`);
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "not_active_scheduler" }, null, 2));
    return;
  }
  const { executeScheduledTick } = await import("@/lib/engine/run-scheduled-tick");
  const result = await executeScheduledTick();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error("[scripts/tick] végzetes hiba:", e);
  process.exit(1);
});

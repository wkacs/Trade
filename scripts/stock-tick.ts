/**
 * Napi részvény-tick a GitHub-runnerben (vagy lokálisan) — a kripto `scripts/tick.ts` párja.
 *
 * Futtatás:  pnpm tsx scripts/stock-tick.ts [--force]
 * Env:       DATABASE_URL kötelező; TRADING_MODE=paper; opcionális STOCK_PAPER_CAPITAL_USD,
 *            MARKETS_ENABLE_STOCKS=1 (különben nincs aktív részvény).
 *
 * Ugyanazt az `executeScheduledStockTick()`-et hívja, mint a Vercel route — egy forrás.
 * `--force`: kihagyja a cadence-kaput (kézi futtatás az ülésidőn kívül is).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

const FORCE = process.argv.includes("--force");

async function main() {
  const { executeScheduledStockTick } = await import("@/lib/engine/run-scheduled-stock-tick");
  const result = await executeScheduledStockTick({ force: FORCE });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error("[scripts/stock-tick] végzetes hiba:", e);
  process.exit(1);
});

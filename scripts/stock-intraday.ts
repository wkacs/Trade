/**
 * Day-trading részvény-ciklus KÉZI futtatása (lokálisan vagy runnerben).
 *
 * Futtatás:  pnpm tsx scripts/stock-intraday.ts [--force]
 * Env:       DATABASE_URL kötelező; MARKETS_ENABLE_STOCKS=1; TRADING_MODE=paper.
 *
 * Ugyanazt az `executeScheduledStockIntraday()`-t hívja, mint az 5 perces cron — egy forrás.
 * `--force`: az ülés-kapu kihagyása (zárt piacon is lefuttatja a ciklust).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

const FORCE = process.argv.includes("--force");

async function main() {
  const { executeScheduledStockIntraday } = await import("@/lib/engine/run-scheduled-stock-intraday");
  const result = await executeScheduledStockIntraday({ force: FORCE });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error("[scripts/stock-intraday] végzetes hiba:", e);
  process.exit(1);
});

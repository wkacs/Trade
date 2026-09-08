import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { executeScheduledStockTick } from "@/lib/engine/run-scheduled-stock-tick";
import { authorizeCronRequest } from "@/lib/ops/cron-auth";

// A napi részvény-tick a Stooq napi gyertyáit tölti és a profit-ciklust futtatja.
export const maxDuration = 300;
export const runtime = "nodejs";

/**
 * Napi részvény-tick trigger (Vercel Cron / külső HTTP-cron / kézi).
 *
 * BIZTONSÁG: ugyanaz a CRON_SECRET-kapu, mint a kripto ticknél (fail-closed). A tényleges
 * logika (cadence + lease + seed + runStockCycle) az `executeScheduledStockTick()`-ben él,
 * hogy a runner-script (`scripts/stock-tick.ts`) ugyanazt futtassa.
 *
 * `?force=1` — kihagyja a cadence-kaput (kézi, egyszeri futtatás az ülésidőn kívül is).
 */
export async function POST(req: Request) {
  const auth = authorizeCronRequest(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const force = new URL(req.url).searchParams.get("force") === "1";
  const run = executeScheduledStockTick({ force })
    .then((result) => {
      if (!result.ok) console.error("[cron/stock-tick] háttérben futó ciklus sikertelen:", result);
      else if (result.skipped) console.log(`[cron/stock-tick] kihagyva: ${result.reason}`);
      else console.log(`[cron/stock-tick] kész: ${result.actions?.length ?? 0} akció`);
    })
    .catch((e) => console.error("[cron/stock-tick] ciklus hiba:", e));
  waitUntil(run);

  return NextResponse.json({ ok: true, accepted: true }, { status: 202 });
}

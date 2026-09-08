import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { executeScheduledStockIntraday } from "@/lib/engine/run-scheduled-stock-intraday";
import { authorizeCronRequest } from "@/lib/ops/cron-auth";

// A day-trading ciklus 5 perces Yahoo-gyertyákat tölt és az ülés fázisa szerint dönt.
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Day-trading részvény-ciklus trigger (kézi vagy külön külső cron).
 *
 * Normál üzemben NEM ezt hívja a cron: az 5 perces `/api/cron/exit` már elindítja a
 * részvény-ciklust is, mert a projektnek egyetlen 5 perces külső időzítője van. Ez a
 * végpont a kézi próbához és egy esetleges KÜLÖN időzítéshez van.
 *
 * `?force=1` — kihagyja az ülés-kaput (zárt piacon is lefuttatja a ciklust).
 */
export async function POST(req: Request) {
  const auth = authorizeCronRequest(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";

  const cycle = executeScheduledStockIntraday({ force }).then((result) => {
    if (!result.ok) console.error("[cron/stock-intraday] ciklus sikertelen:", result);
    return result;
  });
  waitUntil(cycle);

  return NextResponse.json({ ok: true, accepted: true, cycle: "stock-intraday" }, { status: 202 });
}

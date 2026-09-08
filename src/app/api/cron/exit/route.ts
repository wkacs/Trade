import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { executeScheduledExit } from "@/lib/engine/run-scheduled-exit";
import { executeScheduledStockIntraday } from "@/lib/engine/run-scheduled-stock-intraday";
import { authorizeCronRequest } from "@/lib/ops/cron-auth";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Hitelesített, 5 perces trigger a külső HTTP cron számára.
 *
 * KÉT FÜGGETLEN ciklus indul rajta, mert mindkettő 5 perces ritmusú, és a projektnek
 * egyetlen ilyen ütemű külső időzítője van:
 *  - kripto gyors kilépés (stop / take-profit / trailing),
 *  - részvény DAY TRADING ciklus (csak az amerikai ülés alatt csinál bármit).
 *
 * A kettő NEM függ egymástól: külön lease, külön hiba-ág. Ha az egyik elhasal, a másik
 * attól még lefut — ezért nincs közös `await`, és mindkettő maga naplózza a hibáját.
 */
export async function POST(req: Request) {
  const auth = authorizeCronRequest(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const exitCycle = executeScheduledExit().then((result) => {
    if (!result.ok) console.error("[cron/exit] háttérben futó ciklus sikertelen:", result);
  });
  const stockCycle = executeScheduledStockIntraday()
    .then((result) => {
      if (!result.ok) console.error("[cron/exit] részvény day-trading ciklus sikertelen:", result);
    })
    .catch((e) => console.error("[cron/exit] részvény day-trading ciklus kivétel:", e));

  waitUntil(Promise.allSettled([exitCycle, stockCycle]));

  return NextResponse.json({ ok: true, accepted: true, cycles: ["exit", "stock-intraday"] }, { status: 202 });
}

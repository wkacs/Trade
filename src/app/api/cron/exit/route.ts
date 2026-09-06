import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { executeScheduledExit } from "@/lib/engine/run-scheduled-exit";
import { authorizeCronRequest } from "@/lib/ops/cron-auth";

export const maxDuration = 60;
export const runtime = "nodejs";

/** Hitelesített, 5 perces gyors kilépés-trigger a külső HTTP cron számára. */
export async function POST(req: Request) {
  const auth = authorizeCronRequest(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const exitCycle = executeScheduledExit().then((result) => {
    if (!result.ok) console.error("[cron/exit] háttérben futó ciklus sikertelen:", result);
  });
  waitUntil(exitCycle);

  return NextResponse.json({ ok: true, accepted: true, cycle: "exit" }, { status: 202 });
}

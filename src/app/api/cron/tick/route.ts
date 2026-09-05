import { NextResponse } from "next/server";
import { executeScheduledTick } from "@/lib/engine/run-scheduled-tick";
import { authorizeCronRequest } from "@/lib/ops/cron-auth";

// A tick több külső hívást tesz (collectorok párhuzamosan + 1-2 LLM hívás + DB),
// ezért a Fluid Compute-os Hobby projekt jelenlegi 300s plafonját használjuk. Az
// ütemező lehet külső HTTP-cron is; maga a kereskedési ciklus ezen a Vercel route-on fut.
export const maxDuration = 300;
// Node runtime kell (neon, openai SDK, crypto) — nem Edge.
export const runtime = "nodejs";

/**
 * Vercel Cron / manuális tick-trigger. Lásd spec §4.
 *
 * BIZTONSÁG: a CRON_SECRET ellenőrzése (Authorization: Bearer ...). Hosted
 * környezetben hiányzó secret mellett fail-closed. Auth nélküli helyi teszt csak
 * az explicit ALLOW_UNAUTHENTICATED_LOCAL_CRON=true kapcsolóval mehet.
 *
 * A tényleges logika (idempotencia + runTick + mentés + kiértékelés) a megosztott
 * executeScheduledTick()-ben él, hogy a runner-script ugyanazt futtassa.
 */
export async function POST(req: Request) {
  const auth = authorizeCronRequest(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const result = await executeScheduledTick();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

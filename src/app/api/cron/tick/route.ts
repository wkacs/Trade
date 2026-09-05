import { NextResponse } from "next/server";
import { executeScheduledTick } from "@/lib/engine/run-scheduled-tick";
import { authorizeCronRequest } from "@/lib/ops/cron-auth";

// A tick több külső hívást tesz (collectors párhuzamosan + 1-2 LLM hívás + DB),
// ezért megemeljük a függvény-időkorlátot (Vercelen a default 10s kevés lehet).
// MEGJEGYZÉS: a Hobby plafon 60s — cold-starton a tick ezt túllépheti → 504. Ezért
// az ELSŐDLEGES ütemezés a GitHub-runner (scripts/tick.ts, nincs 60s limit); ez a
// route manuális/backup hívásra marad. Lásd run-scheduled-tick.ts + .github/workflows/tick.yml.
export const maxDuration = 60;
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

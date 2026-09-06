import { NextResponse } from "next/server";
import { ACTIVE_SHADOW_LANES } from "@/lib/backtest/shadow-lanes";
import { shadowReport } from "@/lib/backtest/shadow-store";
import { getDb } from "@/db/client";

// Élő mérési állapot — sosem prerenderelhető.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A futó, előre menő árnyék-mérések állapota a dashboardhoz.
 *
 * Minden sáv KÜLÖN hibázhat: egy provisionálatlan vagy hibás sáv nem viheti el a
 * többit, és a hiba LÁTSZIK, nem üres listaként tűnik el.
 */
export async function GET() {
  if (!getDb()) {
    return NextResponse.json(
      { lanes: [], note: "DATABASE_URL hiányzik." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const lanes = await Promise.all(
    ACTIVE_SHADOW_LANES.map(async (lane) => {
      const head = {
        namespace: lane.namespace,
        candidateId: lane.candidateId,
        note: lane.note,
        capitalUsd: lane.capitalUsd,
      };
      try {
        const report = await shadowReport(lane.namespace);
        return {
          ...head,
          startedAt: report.startedAt,
          targetDays: report.targetDays,
          targetRoundTrips: report.targetRoundTrips,
          rows: report.rows,
          error: null as string | null,
        };
      } catch (e) {
        console.error(`[api/shadow] ${lane.namespace}`, e);
        return {
          ...head,
          startedAt: null,
          targetDays: null,
          targetRoundTrips: null,
          rows: [],
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
  return NextResponse.json({ lanes }, { headers: { "Cache-Control": "no-store" } });
}

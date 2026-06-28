import { NextResponse } from "next/server";
import { getDb, schema } from "@/db/client";
import { desc } from "drizzle-orm";

// Élő napló-adat → on-demand, nem prerenderelhető.
export const dynamic = "force-dynamic";

/** A legutóbbi tick-folyamatok (átláthatóság). DB nélkül üres lista. */
export async function GET(req: Request) {
  const db = getDb();
  if (!db) return NextResponse.json({ ticks: [], note: "DATABASE_URL hiányzik." });
  try {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? "20");
    const rows = await db.query.tickRuns.findMany({
      limit: Math.min(limit, 100),
      orderBy: desc(schema.tickRuns.ts),
    });
    return NextResponse.json({ ticks: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/ticks]", e);
    return NextResponse.json({ ticks: [], error: "DB hiba" }, { status: 500 });
  }
}

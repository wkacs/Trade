import { NextResponse } from "next/server";
import { getDb, schema } from "@/db/client";
import { desc } from "drizzle-orm";

// Élő adat + query paramétert (limit) olvas → on-demand, nem prerenderelhető.
export const dynamic = "force-dynamic";

/**
 * AI döntések története (érveléssel együtt). Ez a „saját vélemény" idővonala.
 * Ha nincs DB, üres listát ad.
 */
export async function GET(req: Request) {
  const db = getDb();
  if (!db) {
    return NextResponse.json({ decisions: [], note: "DATABASE_URL hiányzik." });
  }
  try {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const rows = await db.query.decisions.findMany({
      limit: Math.min(limit, 200),
      orderBy: desc(schema.decisions.ts),
    });
    return NextResponse.json({ decisions: rows });
  } catch (e) {
    console.error("[api/decisions]", e);
    return NextResponse.json({ decisions: [], error: "DB hiba" }, { status: 500 });
  }
}

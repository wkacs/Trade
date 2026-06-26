import { NextResponse } from "next/server";
import { getDb, schema } from "@/db/client";
import { desc } from "drizzle-orm";
import { getPerformanceSummary } from "@/lib/portfolio/evaluate";

// Élő adat: minden kérésnél a DB-ből olvas, nem prerenderelhető build-időben.
// Enélkül a Next.js statikusan cache-elné a build-kori (üres) pillanatképet,
// és a dashboard sosem frissülne. Lásd spec §3.5.
export const dynamic = "force-dynamic";

/**
 * Jelenlegi portfólió-állapot (cash + nyitott pozíciók + friss tranzakciók).
 * Ha nincs DB kapcsolat (pl. lokális kulcsok nélkül), üres alapértelmezettel tér vissza.
 */
export async function GET() {
  const db = getDb();
  if (!db) {
    return NextResponse.json({
      portfolio: null,
      positions: [],
      recentTrades: [],
      note: "DATABASE_URL nincs beállítva — demo adatok nélkül.",
    });
  }
  try {
    const portfolio = await db.query.portfolios.findFirst();
    const openPositions = await db.query.positions.findMany();
    const recentTrades = await db.query.trades.findMany({
      limit: 20,
      orderBy: desc(schema.trades.executedAt),
    });
    // „Bejött volna?" összesítő — best-effort (hiba/oszlop hiánya esetén üres summary).
    const performance = await getPerformanceSummary();
    return NextResponse.json({ portfolio, positions: openPositions, recentTrades, performance });
  } catch (e) {
    console.error("[api/portfolio]", e);
    return NextResponse.json(
      { error: "DB hiba", portfolio: null, positions: [], recentTrades: [] },
      { status: 500 },
    );
  }
}

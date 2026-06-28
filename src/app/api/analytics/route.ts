import { NextResponse } from "next/server";
import { getClosedTrades, getBreakdowns, getRealizedEquityCurve } from "@/lib/portfolio/analytics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Realized teljesítmény: lezárt trade-ek + bontások + equity-görbe. DB nélkül üres. */
export async function GET() {
  try {
    const [closedTrades, breakdowns, equityCurve] = await Promise.all([
      getClosedTrades(),
      getBreakdowns(),
      getRealizedEquityCurve(),
    ]);
    return NextResponse.json(
      { closedTrades, breakdowns, equityCurve },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[api/analytics]", e);
    return NextResponse.json(
      { closedTrades: [], breakdowns: { byCoin: [], byExitOrigin: [] }, equityCurve: [], error: "DB hiba" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

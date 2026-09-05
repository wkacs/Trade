import { NextResponse } from "next/server";
import { getClosedTrades, getBreakdowns, getRealizedEquityCurve, getPerformanceReport } from "@/lib/portfolio/analytics";
import { loadPortfolioState } from "@/lib/portfolio/accounting";
import { getPerformanceSummary } from "@/lib/portfolio/evaluate";
import { getTradingMode } from "@/lib/config";
import { dec } from "@/lib/portfolio/money";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Realized teljesítmény: lezárt trade-ek + bontások + equity-görbe.
 *
 * T23: a NETTÓ eredmény és az IRÁNYTALÁLAT KÜLÖN mező — a kettő nem ugyanaz. A hiányzó
 * költségadat `null`, nem nulla, hogy a kijelzés ne sugalljon díjmentes működést.
 */
export async function GET() {
  try {
    const [closedTrades, breakdowns, equityCurve, portfolio, direction] = await Promise.all([
      getClosedTrades(),
      getBreakdowns(),
      getRealizedEquityCurve(),
      loadPortfolioState(),
      getPerformanceSummary(),
    ]);

    // Nettó eredmény a v2 fill-ledgerből (a legacy sorok kimaradnak, de látszanak).
    const ledgerReport = portfolio
      ? await getPerformanceReport(
          { portfolioId: portfolio.portfolioId, mode: getTradingMode() },
          dec(portfolio.initialCapitalUsd),
        )
      : null;

    return NextResponse.json(
      {
        closedTrades,
        breakdowns,
        equityCurve,
        net: ledgerReport
          ? {
              realizedPnlUsd: ledgerReport.realizedPnlUsd,
              unrealizedPnlUsd: ledgerReport.unrealizedPnlUsd,
              totalFeesUsd: ledgerReport.totalFeesUsd,
              realizations: ledgerReport.realizations.length,
              legacyExcluded: ledgerReport.legacy.fills,
              problems: ledgerReport.problems.length,
            }
          : null,
        // IRÁNYTALÁLAT — NEM profit. Külön mezőben, külön néven.
        direction: {
          scored: direction.actionable,
          hitRate: direction.hitRate,
          avgScorePct: direction.avgDirectionalScorePct,
          unscored: direction.unscored,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[api/analytics]", e);
    return NextResponse.json(
      {
        closedTrades: [],
        breakdowns: { byCoin: [], byExitOrigin: [] },
        equityCurve: [],
        net: null,
        direction: null,
        error: "DB hiba",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

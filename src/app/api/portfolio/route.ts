import { NextResponse } from "next/server";
import { getDb, schema } from "@/db/client";
import { desc } from "drizzle-orm";
import { getPerformanceSummary } from "@/lib/portfolio/evaluate";
import { loadLedgerState, hasLedgerState } from "@/lib/execution/order-store";
import { STOCK_PORTFOLIO_ID, STOCK_QUOTE } from "@/lib/engine/stock-tick";
import { cashOf } from "@/lib/portfolio/ledger";
import { toNumber, div, isPositive } from "@/lib/portfolio/money";

// Élő adat: minden kérésnél a DB-ből olvas, nem prerenderelhető build-időben.
// Enélkül a Next.js statikusan cache-elné a build-kori (üres) pillanatképet,
// és a dashboard sosem frissülne. Lásd spec §3.5.
export const dynamic = "force-dynamic";

/** A részvény-sáv SAJÁT pénztárcája — a külön `stock-paper` USD-ledger scope-ból. */
export interface StockLane {
  /** Igaz, ha a részvény-ledger már inicializált (van cash/pozíció sor). */
  initialized: boolean;
  cashUsd: number;
  quote: string;
  positions: { symbol: string; qty: number; entryPrice: number; stopPrice?: number }[];
}

/** A részvény pénztárca betöltése. DB nélkül vagy hibánál nem-inicializált üres sáv. */
async function loadStockLane(): Promise<StockLane> {
  const empty: StockLane = { initialized: false, cashUsd: 0, quote: STOCK_QUOTE, positions: [] };
  const db = getDb();
  if (!db) return empty;
  try {
    const scope = { portfolioId: STOCK_PORTFOLIO_ID, mode: "paper" as const };
    if (!(await hasLedgerState(scope))) return empty;
    const ledger = await loadLedgerState(scope, STOCK_QUOTE);
    const positions = Object.values(ledger.positions)
      .filter((p) => isPositive(p.qty))
      .map((p) => ({
        symbol: p.symbol,
        qty: toNumber(p.qty),
        entryPrice: toNumber(div(p.costBasisQuote, p.qty)),
        stopPrice: p.stopPrice ? toNumber(p.stopPrice) : undefined,
      }));
    return { initialized: true, cashUsd: toNumber(cashOf(ledger, STOCK_QUOTE)), quote: STOCK_QUOTE, positions };
  } catch (e) {
    console.error("[api/portfolio] részvény-sáv:", e);
    return empty;
  }
}

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
      stock: { initialized: false, cashUsd: 0, quote: STOCK_QUOTE, positions: [] } satisfies StockLane,
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
    // A részvény-sáv SAJÁT, elkülönített USD-pénztárcája (stock-paper scope).
    const stock = await loadStockLane();
    return NextResponse.json(
      { portfolio, positions: openPositions, recentTrades, performance, stock },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[api/portfolio]", e);
    return NextResponse.json(
      {
        error: "DB hiba",
        portfolio: null,
        positions: [],
        recentTrades: [],
        stock: { initialized: false, cashUsd: 0, quote: STOCK_QUOTE, positions: [] } satisfies StockLane,
      },
      { status: 500 },
    );
  }
}

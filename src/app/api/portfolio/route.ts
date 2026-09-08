import { NextResponse } from "next/server";
import { getDb, getSql, schema } from "@/db/client";
import { desc } from "drizzle-orm";
import { getPerformanceSummary } from "@/lib/portfolio/evaluate";
import { loadLedgerState, hasLedgerState } from "@/lib/execution/order-store";
import { STOCK_PORTFOLIO_ID, STOCK_QUOTE } from "@/lib/engine/stock-tick";
import { activeByClass } from "@/lib/markets/registry";
import { resolveEntryShape } from "@/lib/strategy/intraday-entries";
import { cashOf } from "@/lib/portfolio/ledger";
import { toNumber, div, isPositive } from "@/lib/portfolio/money";

// Élő adat: minden kérésnél a DB-ből olvas, nem prerenderelhető build-időben.
// Enélkül a Next.js statikusan cache-elné a build-kori (üres) pillanatképet,
// és a dashboard sosem frissülne. Lásd spec §3.5.
export const dynamic = "force-dynamic";

/** Egy elszámolt részvény-kötés a dashboard számára. */
export interface StockFill {
  symbol: string;
  side: string;
  qty: number;
  amountUsd: number;
  price: number;
  /** momentum | stop-loss | take-profit | eod-flat | dca — az intent eredete. */
  origin: string | null;
  executedAt: string;
}

/**
 * A futó belépő-alak neve. Ismeretlen névre `built-in`, mert a ciklus is oda esik
 * vissza — így az API nem állít mást, mint ami valójában fut.
 */
function activeEntryShapeName(): string {
  const raw = (process.env.STOCK_INTRADAY_ENTRY_SHAPE ?? "").trim();
  return resolveEntryShape(raw) ? raw : "built-in";
}

/** A részvény-sáv SAJÁT pénztárcája — a külön `stock-paper` USD-ledger scope-ból. */
export interface StockLane {
  /** Igaz, ha a részvény-ledger már inicializált (van cash/pozíció sor). */
  initialized: boolean;
  cashUsd: number;
  quote: string;
  positions: { symbol: string; qty: number; entryPrice: number; stopPrice?: number }[];
  /** A legutóbbi kötések (day trading: ezek a mai nap kereskedései). */
  recentFills: StockFill[];
  /**
   * A ténylegesen FUTÓ belépő-alak neve (`built-in`, ha a beépített kitörés-jel dönt).
   *
   * Miért van itt: az alakot környezeti változó választja, amit a Vercelen kívülről nem
   * lehet visszaolvasni (a tárolt érték titkosított). Enélkül nem lenne ellenőrizhető,
   * hogy egy átállítás valóban hatott-e az élő futásra.
   */
  entryShape: string;
  /**
   * Igaz, ha a részvény sáv TÉNYLEG fegyverben van: van aktív részvény-instrumentum
   * (`MARKETS_ENABLE_STOCKS`). Ez KÜLÖN kérdés a pénztárcától: a ledger a seed óta akkor is
   * mutat egyenleget, ha a flag közben lekapcsolt — ilyenkor a ciklus némán kihagyja magát,
   * és a felület egészséges automatizálásnak látszana. Enélkül egy env-elírás észrevétlen marad.
   */
  enabled: boolean;
}

/**
 * A részvény-sáv legutóbbi kötései. A fill maga nem hordozza az eredetet (momentum /
 * stop-loss / nap végi zárás), ezért az intent-táblából olvassuk hozzá — enélkül a
 * dashboardon nem lenne látható, MIÉRT történt a kötés.
 */
async function loadStockFills(limit = 12): Promise<StockFill[]> {
  const sql = getSql();
  if (!sql) return [];
  try {
    const rows = (await sql`
      SELECT f.symbol, f.side, f.filled_base_qty, f.gross_quote_amount, f.fill_price,
             f.executed_at, i.origin
        FROM execution_fills f
        LEFT JOIN execution_intents i ON i.intent_id = f.intent_id
       WHERE f.portfolio_id = ${STOCK_PORTFOLIO_ID}
       ORDER BY f.executed_at DESC
       LIMIT ${limit}
    `) as {
      symbol: string;
      side: string;
      filled_base_qty: string;
      gross_quote_amount: string;
      fill_price: string;
      executed_at: string;
      origin: string | null;
    }[];
    return rows.map((r) => ({
      symbol: r.symbol,
      side: r.side,
      qty: Number(r.filled_base_qty),
      amountUsd: Number(r.gross_quote_amount),
      price: Number(r.fill_price),
      origin: r.origin,
      executedAt: new Date(r.executed_at).toISOString(),
    }));
  } catch (e) {
    console.error("[api/portfolio] részvény-kötések:", e);
    return [];
  }
}

/** A részvény pénztárca betöltése. DB nélkül vagy hibánál nem-inicializált üres sáv. */
async function loadStockLane(): Promise<StockLane> {
  const empty: StockLane = {
    initialized: false,
    cashUsd: 0,
    quote: STOCK_QUOTE,
    positions: [],
    recentFills: [],
    entryShape: activeEntryShapeName(),
      enabled: activeByClass("stock").length > 0,
  };
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
    return {
      initialized: true,
      cashUsd: toNumber(cashOf(ledger, STOCK_QUOTE)),
      quote: STOCK_QUOTE,
      positions,
      recentFills: await loadStockFills(),
      entryShape: activeEntryShapeName(),
      enabled: activeByClass("stock").length > 0,
    };
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
      stock: {
          initialized: false,
          cashUsd: 0,
          quote: STOCK_QUOTE,
          positions: [],
          recentFills: [],
          entryShape: activeEntryShapeName(),
          enabled: activeByClass("stock").length > 0,
        } satisfies StockLane,
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
        stock: {
          initialized: false,
          cashUsd: 0,
          quote: STOCK_QUOTE,
          positions: [],
          recentFills: [],
          entryShape: activeEntryShapeName(),
      enabled: activeByClass("stock").length > 0,
        } satisfies StockLane,
      },
      { status: 500 },
    );
  }
}

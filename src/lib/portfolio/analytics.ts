import { getDb, schema } from "@/db/client";
import { and, asc, eq } from "drizzle-orm";
import { type Dec, ZERO, add, sub, div, mul, dec, toNumber, isPositive } from "@/lib/portfolio/money";
import { emptyLedger, applyFill, type LedgerState } from "@/lib/portfolio/ledger";
import type { Fill, TradingMode } from "@/lib/execution/contracts";
import { computeMetrics } from "@/lib/backtest/metrics";
import type { BacktestMetrics, EquityPoint, RealizationEvent } from "@/lib/backtest/types";

type Db = ReturnType<typeof getDb>;

/**
 * Realizált teljesítmény a FILL-LEDGERBŐL (T18).
 *
 * Az audit §7 hibái, amiket ez javít:
 *  - a régi statisztika csak a VÉGSŐ eladást számolta, ezért a korábbi RÉSZLEGES
 *    profitkivételek eltűntek a hit rate-ből és a profit factorból;
 *  - az eladási díj hol levonódott, hol nem, ezért a kijelzett és a könyvelt eredmény
 *    eltért;
 *  - az equity-görbe a készpénzt külön kezelte a lezárt trade-ektől.
 *
 * Itt EGY forrás van: ugyanaz a `applyFill` reducer, ami élesben könyvel. A `legacy-
 * unverified` sorok KÜLÖN látszanak, mert azok nem hiteles bizonyítékok.
 */

export interface PerformanceReport {
  /** Minden realizálás (a részlegesek is), időrendben. */
  realizations: RealizationEvent[];
  /** A fill-ek után újraszámolt equity-görbe (mark-to-market a záró árakon). */
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  /** A kezdőtőke a LEGELSŐ kötés előtt. */
  startingEquityUsd: number;
  /** Halmozott realizált eredmény (díjak után). */
  realizedPnlUsd: number;
  /** Nem realizált eredmény a megadott árakon. */
  unrealizedPnlUsd: number;
  /** Összes díj quote-ban. */
  totalFeesUsd: number;
  /** Az örökölt, bizonyíthatatlan sorok külön (T11 `legacy-unverified`). */
  legacy: { fills: number; excludedFromMetrics: boolean };
  /** Feldolgozási hibák (pl. fedezethiányos legacy sor) — nem tűnnek el csendben. */
  problems: { fillId: string; code: string; message: string }[];
}

export interface ReplayOptions {
  openingCashUsd: Dec;
  quoteAsset?: string;
  /** Mark-to-market árak a nem realizált eredményhez és a záró equityhez. */
  prices?: Record<string, Dec>;
  /** Az equity-görbe mintavételi köze órában (a Sharpe évesítéséhez). */
  samplingHours?: number;
}

/**
 * Tiszta újrajátszás: fill-ek → realizálások + equity-görbe + metrikák.
 *
 * A `legacy-unverified` sorok NEM kerülnek a metrikákba: azoknál nincs megőrzött
 * tőzsdei azonosító, hiányozhat az eredet, és a stop-fill árak irreálisak lehetnek.
 * A darabszámuk viszont látszik, hogy a kihagyás ne legyen néma.
 */
export function replayFills(
  fills: (Fill & { provenance?: string })[],
  options: ReplayOptions,
): PerformanceReport {
  const quoteAsset = options.quoteAsset ?? "USDT";
  const prices = options.prices ?? {};
  const sorted = [...fills].sort((a, b) => a.executedAt - b.executedAt);
  const legacyCount = sorted.filter((f) => f.provenance === "legacy-unverified").length;
  const usable = sorted.filter((f) => f.provenance !== "legacy-unverified");

  let ledger: LedgerState = emptyLedger(
    usable[0]?.portfolioId ?? "unknown",
    (usable[0]?.mode ?? "paper") as TradingMode,
    options.openingCashUsd,
    quoteAsset,
  );
  const startingEquity = toNumber(options.openingCashUsd);
  const realizations: RealizationEvent[] = [];
  const equityCurve: EquityPoint[] = [];
  const problems: PerformanceReport["problems"] = [];
  let totalFees = ZERO;

  const equityNow = (): number => {
    let total = ledger.cash[quoteAsset] ?? ZERO;
    for (const p of Object.values(ledger.positions)) {
      const px = prices[p.symbol];
      // Ár nélkül a bekerülési értéken szerepel — nem találunk ki piaci árat.
      total = add(total, px ? mul(p.qty, px) : p.costBasisQuote);
    }
    return toNumber(total);
  };

  // A görbe a LEGELSŐ kötés ELŐTTI állapotból indul.
  if (usable.length > 0) equityCurve.push({ ts: usable[0].executedAt - 1, equityUsd: startingEquity });

  for (const fill of usable) {
    const before = ledger.positions[fill.symbol];
    const qtyBefore = before?.qty ?? ZERO;
    const costBefore = before?.costBasisQuote ?? ZERO;

    const result = applyFill(ledger, fill, { quoteAsset });
    if (!result.applied) {
      if (result.error?.code !== "duplicate_fill") {
        problems.push({ fillId: fill.fillId, code: result.error?.code ?? "unknown", message: result.error?.message ?? "" });
      }
      continue;
    }
    ledger = result.state;
    totalFees = add(totalFees, fill.feeAsset === quoteAsset ? fill.feeAmount : ZERO);

    if (fill.side === "SELL") {
      const costUsed = isPositive(qtyBefore) ? mul(costBefore, div(fill.filledBaseQty, qtyBefore)) : ZERO;
      realizations.push({
        ts: fill.executedAt,
        symbol: fill.symbol,
        qty: toNumber(fill.filledBaseQty),
        exitPrice: toNumber(fill.fillPrice),
        pnlUsd: toNumber(result.realizedPnlQuote),
        costBasisUsd: toNumber(costUsed),
        feeUsd: toNumber(fill.feeAmount),
        closesPosition: !ledger.positions[fill.symbol],
        kind: "market",
      });
    }
    equityCurve.push({ ts: fill.executedAt, equityUsd: equityNow() });
  }

  let unrealized = ZERO;
  for (const p of Object.values(ledger.positions)) {
    const px = prices[p.symbol];
    if (!px) continue;
    unrealized = add(unrealized, sub(mul(p.qty, px), p.costBasisQuote));
  }

  return {
    realizations,
    equityCurve,
    metrics: computeMetrics(equityCurve, realizations, 0, {
      samplingHours: options.samplingHours,
      buyFeesUsd: toNumber(totalFees),
    }),
    startingEquityUsd: startingEquity,
    realizedPnlUsd: toNumber(ledger.realizedPnlQuote),
    unrealizedPnlUsd: toNumber(unrealized),
    totalFeesUsd: toNumber(totalFees),
    legacy: { fills: legacyCount, excludedFromMetrics: true },
    problems,
  };
}

// ── A régi, pozíció-alapú összesítők (a meglévő dashboard még ezeket olvassa) ──

export interface ClosedTradeRow {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  qtyClosed: number;
  pnlUsd: number;
  pnlPct: number;
  holdHours: number;
  exitOrigin: string;
  exitTs: number;
}
export interface Breakdown {
  key: string;
  trades: number;
  winRate: number;
  avgPnlPct: number;
}
export interface Breakdowns {
  byCoin: Breakdown[];
  byExitOrigin: Breakdown[];
}
export type { EquityPoint };

interface ClosedPos {
  symbol: string;
  entryPrice: number;
  openedAt: Date;
  closedAt: Date;
}
interface PosTrade {
  side: string;
  amountUsd: number;
  price: number;
  qty: number;
  feeUsd: number;
  origin: string | null;
  executedAt: Date;
}

/**
 * Egy lezárt pozíció round-trip összegzése. A vételi díj is költség: a régi képlet a
 * bruttó vételt vette bekerülési értéknek, és csak az eladási díjat vonta le.
 */
export function summarizeClosedPosition(p: ClosedPos, posTrades: PosTrade[]): ClosedTradeRow {
  const buys = posTrades.filter((t) => t.side === "BUY");
  const sells = posTrades.filter((t) => t.side === "SELL");
  const buyCost = buys.reduce((s, t) => s + t.amountUsd + t.feeUsd, 0);
  const sellNet = sells.reduce((s, t) => s + (t.amountUsd - t.feeUsd), 0);
  const qtyClosed = sells.reduce((s, t) => s + t.qty, 0);
  const exitPrice = qtyClosed > 0 ? sells.reduce((s, t) => s + t.price * t.qty, 0) / qtyClosed : 0;
  const pnlUsd = sellNet - buyCost;
  const pnlPct = buyCost > 0 ? pnlUsd / buyCost : 0;
  const holdHours = (p.closedAt.getTime() - p.openedAt.getTime()) / 3_600_000;
  const lastSell = sells.length
    ? sells.reduce((a, b) => (a.executedAt.getTime() > b.executedAt.getTime() ? a : b))
    : null;
  return {
    symbol: p.symbol,
    entryPrice: p.entryPrice,
    exitPrice,
    qtyClosed,
    pnlUsd,
    pnlPct,
    holdHours,
    exitOrigin: lastSell?.origin ?? "n/a",
    exitTs: p.closedAt.getTime(),
  };
}

function aggregate(rows: ClosedTradeRow[], keyFn: (r: ClosedTradeRow) => string): Breakdown[] {
  const groups = new Map<string, { trades: number; wins: number; sumPnlPct: number }>();
  for (const r of rows) {
    const k = keyFn(r);
    const g = groups.get(k) ?? { trades: 0, wins: 0, sumPnlPct: 0 };
    g.trades += 1;
    if (r.pnlUsd > 0) g.wins += 1;
    g.sumPnlPct += r.pnlPct;
    groups.set(k, g);
  }
  return Array.from(groups.entries()).map(([key, g]) => ({
    key,
    trades: g.trades,
    winRate: g.trades ? g.wins / g.trades : 0,
    avgPnlPct: g.trades ? g.sumPnlPct / g.trades : 0,
  }));
}

export function computeBreakdowns(rows: ClosedTradeRow[]): Breakdowns {
  return { byCoin: aggregate(rows, (r) => r.symbol), byExitOrigin: aggregate(rows, (r) => r.exitOrigin) };
}

/** Az equity-görbe a KEZDŐTŐKÉTŐL indul, és minden realizálással lép. */
export function computeEquityCurve(rows: ClosedTradeRow[], initialCapitalUsd: number): EquityPoint[] {
  const sorted = [...rows].sort((a, b) => a.exitTs - b.exitTs);
  let eq = initialCapitalUsd;
  const out: EquityPoint[] = [];
  if (sorted.length > 0) out.push({ ts: sorted[0].exitTs - 1, equityUsd: initialCapitalUsd });
  for (const r of sorted) {
    eq += r.pnlUsd;
    out.push({ ts: r.exitTs, equityUsd: eq });
  }
  return out;
}

// ── DB-wrapperek (best-effort; null/hiba → biztonságos default, nem dob) ────

/** A v2 fill-ek beolvasása egy hatókörre, időrendben. */
export async function loadFills(
  scope: { portfolioId: string; mode: TradingMode },
  dbOverride?: Db | null,
): Promise<(Fill & { provenance: string })[]> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return [];
  try {
    const rows = await db
      .select()
      .from(schema.executionFills)
      .where(and(eq(schema.executionFills.portfolioId, scope.portfolioId), eq(schema.executionFills.mode, scope.mode)))
      .orderBy(asc(schema.executionFills.executedAt));
    return rows.map((r) => ({
      fillId: r.fillKey,
      intentId: r.intentId,
      portfolioId: r.portfolioId,
      mode: r.mode as TradingMode,
      symbol: r.symbol,
      side: r.side === "SELL" ? "SELL" : "BUY",
      exchangeOrderId: r.exchangeOrderId,
      exchangeTradeId: r.exchangeTradeId,
      filledBaseQty: r.filledBaseQty,
      grossQuoteAmount: r.grossQuoteAmount,
      fillPrice: r.fillPrice,
      feeAmount: r.feeAmount,
      feeAsset: r.feeAsset,
      executedAt: r.executedAt.getTime(),
      provenance: r.provenance,
    }));
  } catch (e) {
    console.error("[analytics] loadFills hiba:", e);
    return [];
  }
}

/** Teljes teljesítmény-jelentés a v2 ledgerből. */
export async function getPerformanceReport(
  scope: { portfolioId: string; mode: TradingMode },
  openingCashUsd: Dec,
  prices: Record<string, Dec> = {},
  dbOverride?: Db | null,
): Promise<PerformanceReport> {
  const fills = await loadFills(scope, dbOverride);
  return replayFills(fills, { openingCashUsd, prices });
}

export async function getClosedTrades(dbOverride?: Db | null): Promise<ClosedTradeRow[]> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return [];
  try {
    const { isNotNull, inArray } = await import("drizzle-orm");
    const positions = await db.select().from(schema.positions).where(isNotNull(schema.positions.closedAt));
    if (positions.length === 0) return [];
    const ids = positions.map((p) => p.id);
    const tradeRows = await db.select().from(schema.trades).where(inArray(schema.trades.positionId, ids));
    const byPos = new Map<string, PosTrade[]>();
    for (const t of tradeRows) {
      if (!t.positionId) continue;
      const arr = byPos.get(t.positionId) ?? [];
      arr.push({
        side: t.side,
        amountUsd: t.amountUsd,
        price: t.price,
        qty: t.qty,
        feeUsd: t.feeUsd,
        origin: t.origin,
        executedAt: t.executedAt,
      });
      byPos.set(t.positionId, arr);
    }
    return positions.map((p) =>
      summarizeClosedPosition(
        { symbol: p.symbol, entryPrice: p.entryPrice, openedAt: p.openedAt, closedAt: p.closedAt! },
        byPos.get(p.id) ?? [],
      ),
    );
  } catch (e) {
    console.error("[analytics] getClosedTrades hiba:", e);
    return [];
  }
}

export async function getBreakdowns(dbOverride?: Db | null): Promise<Breakdowns> {
  return computeBreakdowns(await getClosedTrades(dbOverride));
}

export async function getRealizedEquityCurve(dbOverride?: Db | null): Promise<EquityPoint[]> {
  const rows = await getClosedTrades(dbOverride);
  const db = dbOverride !== undefined ? dbOverride : getDb();
  let initial = 100;
  if (db) {
    try {
      const [p] = await db.select().from(schema.portfolios).limit(1);
      if (p) initial = p.initialCapitalUsd;
    } catch (e) {
      console.error("[analytics] equity initial hiba:", e);
    }
  }
  return computeEquityCurve(rows, initial);
}

export { dec };

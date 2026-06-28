import { getDb, schema } from "@/db/client";
import { isNotNull, inArray } from "drizzle-orm";

type Db = ReturnType<typeof getDb>;

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
export interface EquityPoint {
  ts: number;
  equityUsd: number;
}

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

/** Egy lezárt pozíció round-trip összegzése a hozzá tartozó trade-ekből. Tiszta. */
export function summarizeClosedPosition(p: ClosedPos, posTrades: PosTrade[]): ClosedTradeRow {
  const buys = posTrades.filter((t) => t.side === "BUY");
  const sells = posTrades.filter((t) => t.side === "SELL");
  const buyCost = buys.reduce((s, t) => s + t.amountUsd, 0);
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

export function computeEquityCurve(rows: ClosedTradeRow[], initialCapitalUsd: number): EquityPoint[] {
  const sorted = [...rows].sort((a, b) => a.exitTs - b.exitTs);
  let eq = initialCapitalUsd;
  return sorted.map((r) => {
    eq += r.pnlUsd;
    return { ts: r.exitTs, equityUsd: eq };
  });
}

// ---- DB-wrapperek (best-effort; null/hiba → biztonságos default, nem dob) ----

export async function getClosedTrades(dbOverride?: Db | null): Promise<ClosedTradeRow[]> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return [];
  try {
    const positions = await db
      .select()
      .from(schema.positions)
      .where(isNotNull(schema.positions.closedAt));
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

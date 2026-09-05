/**
 * Régi (v1) demóadatok megőrzése és mérési átállás (T11).
 *
 * ALAPELV: a régi sorokat NEM javítjuk ki kitalált adatokkal, és NEM töröljük.
 *
 * A v1 `trades` tábla korlátai (az auditból):
 *  - nincs megőrzött tőzsdei orderId (a paper broker sosem írta be);
 *  - néhány régi soron hiányzik az `origin`;
 *  - a papír stop-fill árak irreálisak lehetnek (a régi kód a stopárat használta
 *    teljesülési árnak akkor is, ha az észlelt ár alacsonyabb volt);
 *  - a mennyiségek `real` oszlopban vannak, tehát az elveszett pontosság nem állítható vissza.
 *
 * EZÉRT az átállás KÉT külön dolgot csinál, és nem keveri őket:
 *  1. TÖRTÉNET: a régi trade-sorok bekerülnek az `execution_fills` táblába
 *     `legacy-unverified` provenance-szel. Ezek CSAK történeti sorok — NEM mozgatnak
 *     egyenleget, mert egy hiányos, kerekített sorozatból nem lehet hiteles ledgert
 *     visszajátszani.
 *  2. NYITÓÁLLAPOT: az új mérési epoch nyitóegyenlege a v1 portfólió ELLENŐRZÖTT
 *     aktuális állapota (cash + nyitott pozíciók), nem a trade-ek újrajátszása.
 *
 * A tervezés TISZTA függvény, a végrehajtás alapértelmezésben DRY-RUN.
 */
import { type Dec, ZERO, add, mul, div, dec, gt, isPositive } from "@/lib/portfolio/money";
import { fillKey } from "@/lib/execution/contracts";

export interface LegacyPortfolio {
  id: string;
  initialCapitalUsd: number;
  cashUsd: number;
  mode: "paper" | "live";
}

export interface LegacyPosition {
  id: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  closedAt: Date | null;
}

export interface LegacyTrade {
  id: string;
  positionId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  amountUsd: number;
  price: number;
  qty: number;
  feeUsd: number;
  mode: string;
  executedAt: Date;
  origin: string | null;
}

export interface LegacyInput {
  portfolio: LegacyPortfolio;
  positions: LegacyPosition[];
  trades: LegacyTrade[];
}

export interface LegacyFillRow {
  fillId: string;
  intentId: string;
  portfolioId: string;
  mode: "paper" | "live";
  symbol: string;
  side: "BUY" | "SELL";
  exchangeOrderId: string;
  exchangeTradeId: string;
  filledBaseQty: Dec;
  grossQuoteAmount: Dec;
  fillPrice: Dec;
  feeAmount: Dec;
  feeAsset: string;
  executedAt: number;
  provenance: "legacy-unverified";
}

export interface ImportWarning {
  code:
    | "missing_origin"
    | "synthetic_order_id"
    | "suspicious_stop_fill"
    | "zero_or_negative_amount"
    | "unknown_mode"
    | "real_precision_loss";
  tradeId?: string;
  message: string;
}

export interface ImportPlan {
  epochVersion: string;
  portfolioId: string;
  mode: "paper" | "live";
  /** Az epoch nyitóegyenlege — az ELLENŐRZÖTT v1 állapotból, nem újrajátszásból. */
  openingCashQuote: Dec;
  openingPositions: { symbol: string; qty: Dec; costBasisQuote: Dec; stopPrice: Dec | null }[];
  /** A történeti sorok. Egyenleget NEM mozgatnak. */
  legacyFills: LegacyFillRow[];
  warnings: ImportWarning[];
  summary: {
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    grossBuyQuote: Dec;
    grossSellQuote: Dec;
    feesQuote: Dec;
    openPositionCount: number;
    skippedTrades: number;
  };
}

export interface ImportOptions {
  epochVersion: string;
  quoteAsset?: string;
  /**
   * Gyanús stop-fill jelölése: ha egy SELL ára a pozíció stopáránál MAGASABB, a régi kód
   * valószínűleg a stopárat írta fill-árnak. Nem javítjuk, csak jelöljük.
   */
  flagSuspiciousStopFills?: boolean;
}

/**
 * A régi trade determinisztikus, EGYEDI fill-kulcsa. Nincs valódi exchange orderId,
 * ezért a v1 sor UUID-jából képezünk azonosítót — a `legacy:` előtag hangosan jelzi,
 * hogy ez SZINTETIKUS, nem tőzsdei adat.
 */
export function legacyOrderId(tradeId: string): string {
  return `legacy:${tradeId}`;
}

/** Tiszta tervezés: v1 állapot → import-terv. Nincs IO, nincs Date.now. */
export function planLegacyImport(input: LegacyInput, options: ImportOptions): ImportPlan {
  const quoteAsset = options.quoteAsset ?? "USDT";
  const warnings: ImportWarning[] = [];
  const legacyFills: LegacyFillRow[] = [];

  const mode: "paper" | "live" = input.portfolio.mode === "live" ? "live" : "paper";
  const stopBySymbol = new Map<string, number>();
  for (const p of input.positions) stopBySymbol.set(p.symbol, p.stopPrice);

  let grossBuy: Dec = ZERO;
  let grossSell: Dec = ZERO;
  let fees: Dec = ZERO;
  let buyCount = 0;
  let sellCount = 0;
  let skipped = 0;

  for (const t of input.trades) {
    if (!(t.qty > 0) || !(t.amountUsd > 0) || !(t.price > 0)) {
      skipped++;
      warnings.push({
        code: "zero_or_negative_amount",
        tradeId: t.id,
        message: `A ${t.id} sor nem pozitív mennyiséget/összeget tartalmaz — kihagyva, NEM javítva.`,
      });
      continue;
    }
    if (t.mode !== "paper" && t.mode !== "live") {
      warnings.push({ code: "unknown_mode", tradeId: t.id, message: `Ismeretlen mód: ${t.mode}` });
    }
    if (!t.origin) {
      warnings.push({
        code: "missing_origin",
        tradeId: t.id,
        message: `A ${t.id} soron nincs eredet — ismeretlenként marad, nem találjuk ki.`,
      });
    }
    warnings.push({
      code: "synthetic_order_id",
      tradeId: t.id,
      message: `A ${t.id} sorhoz nincs tőzsdei orderId — szintetikus "${legacyOrderId(t.id)}" azonosítót kap.`,
    });

    if (options.flagSuspiciousStopFills !== false && t.side === "SELL") {
      const stop = stopBySymbol.get(t.symbol);
      if (stop !== undefined && stop > 0 && t.price >= stop) {
        warnings.push({
          code: "suspicious_stop_fill",
          tradeId: t.id,
          message:
            `A ${t.id} eladás ára (${t.price}) nem alacsonyabb a nyilvántartott stopnál (${stop}). ` +
            `A régi kód a stopárat írhatta fill-árnak. JELÖLVE, nem javítva.`,
        });
      }
    }

    const orderId = legacyOrderId(t.id);
    const tradeIdStr = `${orderId}-1`;
    const qty = dec(t.qty);
    const gross = dec(t.amountUsd);
    legacyFills.push({
      fillId: fillKey(mode, orderId, tradeIdStr),
      intentId: `legacy-intent:${t.id}`,
      portfolioId: input.portfolio.id,
      mode,
      symbol: t.symbol,
      side: t.side,
      exchangeOrderId: orderId,
      exchangeTradeId: tradeIdStr,
      filledBaseQty: qty,
      grossQuoteAmount: gross,
      fillPrice: dec(t.price),
      feeAmount: dec(t.feeUsd),
      feeAsset: quoteAsset,
      executedAt: t.executedAt.getTime(),
      provenance: "legacy-unverified",
    });

    if (t.side === "BUY") {
      buyCount++;
      grossBuy = add(grossBuy, gross);
    } else {
      sellCount++;
      grossSell = add(grossSell, gross);
    }
    fees = add(fees, dec(t.feeUsd));
  }

  const openPositions = input.positions.filter((p) => p.closedAt === null && p.qty > 0);
  if (openPositions.length > 0 || input.trades.length > 0) {
    warnings.push({
      code: "real_precision_loss",
      message:
        "A v1 oszlopok `real` típusúak — a mennyiségek elveszett pontossága utólag NEM " +
        "állítható vissza. Az epoch nyitóállapota ezért a v1 ellenőrzött állapotának " +
        "legjobb elérhető közelítése, és ezzel a korláttal értendő.",
    });
  }

  return {
    epochVersion: options.epochVersion,
    portfolioId: input.portfolio.id,
    mode,
    openingCashQuote: dec(input.portfolio.cashUsd),
    openingPositions: openPositions.map((p) => ({
      symbol: p.symbol,
      qty: dec(p.qty),
      costBasisQuote: mul(dec(p.qty), dec(p.entryPrice)),
      stopPrice: p.stopPrice > 0 ? dec(p.stopPrice) : null,
    })),
    legacyFills,
    warnings,
    summary: {
      tradeCount: input.trades.length,
      buyCount,
      sellCount,
      grossBuyQuote: grossBuy,
      grossSellQuote: grossSell,
      feesQuote: fees,
      openPositionCount: openPositions.length,
      skippedTrades: skipped,
    },
  };
}

export interface DiffRow {
  key: string;
  before: Dec;
  after: Dec;
  delta: Dec;
}

/** Előtte/utána eltérésjelentés a nyitóállapotról (a dry-run kimenetének magja). */
export function buildDiff(
  before: { cash: Dec; positions: Record<string, Dec> },
  plan: ImportPlan,
): DiffRow[] {
  const rows: DiffRow[] = [
    {
      key: "cash:USDT",
      before: before.cash,
      after: plan.openingCashQuote,
      delta: add(plan.openingCashQuote, mul(before.cash, "-1")),
    },
  ];
  const symbols = new Set([...Object.keys(before.positions), ...plan.openingPositions.map((p) => p.symbol)]);
  for (const symbol of Array.from(symbols).sort()) {
    const b = before.positions[symbol] ?? ZERO;
    const a = plan.openingPositions.find((p) => p.symbol === symbol)?.qty ?? ZERO;
    rows.push({ key: `qty:${symbol}`, before: b, after: a, delta: add(a, mul(b, "-1")) });
  }
  return rows;
}

/**
 * A 20% feletti koncentráció felismerése. A migráció NEM ad el semmit; ez csak jelentés,
 * és a kockázati kapu amúgy is 0 szabad keretet ad az érintett coinra.
 */
export function detectOverweight(
  plan: ImportPlan,
  prices: Record<string, Dec>,
  maxPositionPct: Dec,
): { symbol: string; valueQuote: Dec; sharePct: Dec }[] {
  let equity = plan.openingCashQuote;
  for (const p of plan.openingPositions) {
    const px = prices[p.symbol];
    if (px) equity = add(equity, mul(p.qty, px));
  }
  if (!isPositive(equity)) return [];
  const out: { symbol: string; valueQuote: Dec; sharePct: Dec }[] = [];
  for (const p of plan.openingPositions) {
    const px = prices[p.symbol];
    if (!px) continue;
    const value = mul(p.qty, px);
    const share = div(value, equity);
    if (gt(share, maxPositionPct)) out.push({ symbol: p.symbol, valueQuote: value, sharePct: share });
  }
  return out;
}

/** Emberi olvasásra szánt összefoglaló a dry-run kimenetéhez. */
export function formatPlanSummary(plan: ImportPlan): string {
  const byCode = new Map<string, number>();
  for (const w of plan.warnings) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
  const warningLines = Array.from(byCode.entries())
    .sort()
    .map(([code, n]) => `  - ${code}: ${n}`);
  return [
    `Epoch: ${plan.epochVersion} (${plan.portfolioId} / ${plan.mode})`,
    `Nyitó készpénz: ${plan.openingCashQuote}`,
    `Nyitó pozíciók: ${plan.openingPositions.map((p) => `${p.symbol}=${p.qty}`).join(", ") || "nincs"}`,
    `Történeti sorok: ${plan.legacyFills.length} (kihagyva: ${plan.summary.skippedTrades})`,
    `BUY/SELL: ${plan.summary.buyCount}/${plan.summary.sellCount}, bruttó ${plan.summary.grossBuyQuote}/${plan.summary.grossSellQuote}, díj ${plan.summary.feesQuote}`,
    "Figyelmeztetések:",
    ...warningLines,
  ].join("\n");
}

// ── DB-réteg ────────────────────────────────────────────────────────────────

import { getDb, getSql, schema, type Db } from "@/db/client";
import { and, eq, isNull } from "drizzle-orm";

/** A v1 állapot beolvasása. CSAK SELECT. */
export async function readLegacyState(dbOverride?: Db | null): Promise<LegacyInput | null> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return null;
  const [portfolio] = await db.select().from(schema.portfolios).limit(1);
  if (!portfolio) return null;
  const positions = await db.select().from(schema.positions);
  const trades = await db.select().from(schema.trades);
  return {
    portfolio: {
      id: portfolio.id,
      initialCapitalUsd: portfolio.initialCapitalUsd,
      cashUsd: portfolio.cashUsd,
      mode: portfolio.mode === "live" ? "live" : "paper",
    },
    positions: positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      qty: p.qty,
      entryPrice: p.entryPrice,
      stopPrice: p.stopPrice,
      closedAt: p.closedAt,
    })),
    trades: trades.map((t) => ({
      id: t.id,
      positionId: t.positionId,
      symbol: t.symbol,
      side: t.side === "SELL" ? "SELL" : "BUY",
      amountUsd: t.amountUsd,
      price: t.price,
      qty: t.qty,
      feeUsd: t.feeUsd,
      mode: t.mode,
      executedAt: t.executedAt,
      origin: t.origin,
    })),
  };
}

export interface ApplyResult {
  epochCreated: boolean;
  legacyFillsInserted: number;
  legacyFillsSkipped: number;
  openingSeeded: boolean;
}

/**
 * A terv VÉGREHAJTÁSA. Idempotens: kétszeri futtatás ugyanazt az eredményt adja, mert
 * a fill-kulcsok determinisztikusak és az epoch (portfolio, mode, version) egyedi.
 *
 * A régi `portfolios`, `positions` és `trades` sorok ÉRINTETLENÜL maradnak.
 */
export async function applyLegacyImport(
  plan: ImportPlan,
  startedAtMs: number,
  dbOverride?: Db | null,
): Promise<ApplyResult> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  const sql = getSql();
  if (!db) throw new Error("[legacy-import] nincs adatbázis-kapcsolat");

  // 1) Epoch rögzítése (idempotens).
  const existingEpoch = await db
    .select({ id: schema.ledgerEpochs.id })
    .from(schema.ledgerEpochs)
    .where(
      and(
        eq(schema.ledgerEpochs.portfolioId, plan.portfolioId),
        eq(schema.ledgerEpochs.mode, plan.mode),
        eq(schema.ledgerEpochs.epochVersion, plan.epochVersion),
      ),
    )
    .limit(1);

  let epochCreated = false;
  if (existingEpoch.length === 0) {
    await db.insert(schema.ledgerEpochs).values({
      portfolioId: plan.portfolioId,
      mode: plan.mode,
      epochVersion: plan.epochVersion,
      startedAt: new Date(startedAtMs),
      openingCashQuote: plan.openingCashQuote,
      openingPositions: plan.openingPositions,
      note:
        "A nyitóállapot a v1 ELLENŐRZÖTT állapotából származik, nem a régi trade-ek " +
        "újrajátszásából. A régi sorok legacy-unverified provenance-szel, történetként kerülnek be.",
    });
    epochCreated = true;
  }

  // 2) Nyitóállapot (csak ha még nincs ledger-sor).
  const existingCash = await db
    .select({ id: schema.ledgerCash.id })
    .from(schema.ledgerCash)
    .where(and(eq(schema.ledgerCash.portfolioId, plan.portfolioId), eq(schema.ledgerCash.mode, plan.mode)))
    .limit(1);
  let openingSeeded = false;
  if (existingCash.length === 0) {
    await db.insert(schema.ledgerCash).values({
      portfolioId: plan.portfolioId,
      mode: plan.mode,
      asset: "USDT",
      amount: plan.openingCashQuote,
    });
    for (const p of plan.openingPositions) {
      await db
        .insert(schema.ledgerPositions)
        .values({
          portfolioId: plan.portfolioId,
          mode: plan.mode,
          symbol: p.symbol,
          qty: p.qty,
          costBasisQuote: p.costBasisQuote,
          stopPrice: p.stopPrice,
        })
        .onConflictDoNothing();
    }
    openingSeeded = true;
  }

  // 3) Történeti sorok — EGYENLEGET NEM MOZGATNAK, ezért sima INSERT, nem apply_fill_v2.
  let inserted = 0;
  let skippedFills = 0;
  for (const f of plan.legacyFills) {
    const rows = await db
      .insert(schema.executionFills)
      .values({
        fillKey: f.fillId,
        intentId: f.intentId,
        portfolioId: f.portfolioId,
        mode: f.mode,
        symbol: f.symbol,
        side: f.side,
        exchangeOrderId: f.exchangeOrderId,
        exchangeTradeId: f.exchangeTradeId,
        filledBaseQty: f.filledBaseQty,
        grossQuoteAmount: f.grossQuoteAmount,
        fillPrice: f.fillPrice,
        feeAmount: f.feeAmount,
        feeAsset: f.feeAsset,
        executedAt: new Date(f.executedAt),
        provenance: f.provenance,
      })
      .onConflictDoNothing()
      .returning({ id: schema.executionFills.id });
    if (rows.length > 0) inserted++;
    else skippedFills++;
  }

  void sql;
  return { epochCreated, legacyFillsInserted: inserted, legacyFillsSkipped: skippedFills, openingSeeded };
}

/** Az aktuális v2 nyitóállapot beolvasása az eltérésjelentéshez. */
export async function readCurrentLedgerSnapshot(
  portfolioId: string,
  mode: "paper" | "live",
  dbOverride?: Db | null,
): Promise<{ cash: Dec; positions: Record<string, Dec> }> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return { cash: ZERO, positions: {} };
  const cashRows = await db
    .select()
    .from(schema.ledgerCash)
    .where(and(eq(schema.ledgerCash.portfolioId, portfolioId), eq(schema.ledgerCash.mode, mode)));
  const posRows = await db
    .select()
    .from(schema.ledgerPositions)
    .where(
      and(
        eq(schema.ledgerPositions.portfolioId, portfolioId),
        eq(schema.ledgerPositions.mode, mode),
        isNull(schema.ledgerPositions.closedAt),
      ),
    );
  return {
    cash: cashRows.find((r) => r.asset === "USDT")?.amount ?? ZERO,
    positions: Object.fromEntries(posRows.map((r) => [r.symbol, r.qty])),
  };
}

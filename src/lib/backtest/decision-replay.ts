/**
 * Rögzített AI-döntések visszajátszása (T20).
 *
 * MIÉRT NEM ELÉG ÚJRAFUTTATNI AZ LLM-ET: egy mai modell a régi híreken már ismerheti a
 * kimenetelt (a hír-korpusz, a betanítási adat és az emberi utólagos tudás mind
 * beszivároghat). Egy ilyen futtatás NEM történelmi bizonyíték.
 *
 * Ezért kizárólag olyan döntést szabad visszajátszani, amit AKKOR rögzítettünk:
 * időbélyeggel, a döntéskori árakkal és a modell azonosítójával együtt. Amit nem
 * rögzítettünk, az hiányzik — és hiányzóként is marad.
 *
 * A modul tiszta: nincs IO, nincs Date.now, nincs LLM-hívás.
 */
import { type Dec, ZERO, add, mul, div, dec, toNumber, isPositive } from "@/lib/portfolio/money";
import { emptyLedger, applyFill, cashOf, equityAt, positionQty, type LedgerState } from "@/lib/portfolio/ledger";
import { fillKey, type Fill } from "@/lib/execution/contracts";
import { evaluateOrder, type OrderRiskContext, type OrderRiskParams, DEFAULT_ORDER_RISK_PARAMS } from "@/lib/risk/risk-manager";

/** Egy AKKOR rögzített döntés (a decisions tábla sora). */
export interface RecordedDecision {
  id: string;
  /** A döntés ideje (epoch ms). */
  ts: number;
  tickId: string;
  action: "BUY" | "SELL" | "HOLD";
  symbol: string | null;
  /** BUY: equity-hányad, SELL: pozíció-hányad (v2). v1-nél mindkettő amountPct volt. */
  amountPct: number;
  confidence: number;
  model: string;
  /** A döntéskori pillanatkép. Enélkül a döntés NEM játszható vissza. */
  ref: { prices: Record<string, number>; intent: "BUY" | "SELL" | "HOLD"; intentSymbol: string | null; intentAmountPct: number } | null;
  /** A séma verziója. Hiányzik → v1 jelentés. */
  schemaVersion?: number;
  /** Mikor került a sor az adatbázisba. Ha jóval a `ts` UTÁN, az gyanús. */
  recordedAt?: number;
  /** Az LLM mérhető költsége (T16). */
  llm?: { model: string; promptVersion: string; totalTokens: number | null; latencyMs: number } | null;
}

export type ReplayRejection =
  | "future_intent"
  | "missing_ref"
  | "missing_price"
  | "generated_after_the_fact"
  | "unknown_symbol";

export interface ReplayValidation {
  ok: boolean;
  reason?: ReplayRejection;
  message?: string;
}

export interface ValidateOptions {
  /** A visszajátszás „mostja". Ennél későbbi döntés JÖVŐBELI — tilos. */
  nowMs: number;
  allowedSymbols: string[];
  /**
   * Mennyivel később kerülhetett a sor az adatbázisba a döntés idejéhez képest.
   * Ezen túl a sor UTÓLAG GYÁRTOTTNAK számít, és nem bizonyíték.
   */
  maxRecordLagMs?: number;
}

const DEFAULT_RECORD_LAG_MS = 15 * 60 * 1000;

/** Visszajátszható-e ez a döntés? Szigorú: kétség esetén NEM. */
export function validateForReplay(d: RecordedDecision, opts: ValidateOptions): ReplayValidation {
  if (d.ts > opts.nowMs) {
    return { ok: false, reason: "future_intent", message: `A döntés ideje (${d.ts}) a visszajátszás mostja után van.` };
  }
  if (!d.ref || !d.ref.prices) {
    return { ok: false, reason: "missing_ref", message: "Nincs döntéskori pillanatkép — nem rekonstruálható." };
  }
  const lag = d.recordedAt !== undefined ? d.recordedAt - d.ts : 0;
  if (lag > (opts.maxRecordLagMs ?? DEFAULT_RECORD_LAG_MS)) {
    return {
      ok: false,
      reason: "generated_after_the_fact",
      message: `A sor ${Math.round(lag / 60000)} perccel a döntés után került be — utólag gyártott, nem bizonyíték.`,
    };
  }
  if (d.action !== "HOLD") {
    if (!d.symbol || !opts.allowedSymbols.includes(d.symbol)) {
      return { ok: false, reason: "unknown_symbol", message: `Ismeretlen vagy hiányzó szimbólum: ${d.symbol}` };
    }
    if (d.ref.prices[d.symbol] === undefined) {
      return { ok: false, reason: "missing_price", message: `Nincs döntéskori ár a ${d.symbol}-ra.` };
    }
  }
  return { ok: true };
}

export interface ReplayCost {
  /** Az LLM tokenköltsége USD-ben (a hívó adja meg az árat). */
  llmCostUsd: number;
  totalTokens: number;
  calls: number;
}

export interface ReplayResult {
  /** A futás végi ledger. */
  ledger: LedgerState;
  /** Equity a futás elején és végén. */
  startingEquityUsd: number;
  endingEquityUsd: number;
  executed: number;
  /** Miért maradt ki egy döntés — kódonként. */
  skipped: Record<string, number>;
  /** A kihagyott döntések azonosítói (visszakereshetőség). */
  skippedIds: { id: string; reason: ReplayRejection | "risk" | "no_fill" }[];
  cost: ReplayCost;
}

export interface ReplayOptions {
  openingCashUsd: Dec;
  allowedSymbols: string[];
  nowMs: number;
  feePct?: Dec;
  slippageBps?: number;
  riskParams?: OrderRiskParams;
  maxRecordLagMs?: number;
  /** USD / 1000 token. 0 → nincs elszámolt LLM-költség. */
  llmCostPer1kTokens?: number;
  quoteAsset?: string;
}

/**
 * A rögzített döntések végrehajtása a DÖNTÉSKORI árakon, a közös kockázati kapun és a
 * közös fill-könyvelőn. Ugyanaz a motor, mint élesben — csak az intent jön a naplóból.
 */
export function replayDecisions(decisions: RecordedDecision[], options: ReplayOptions): ReplayResult {
  const quoteAsset = options.quoteAsset ?? "USDT";
  const feePct = options.feePct ?? "0.001";
  const slip = dec(String((options.slippageBps ?? 5) / 10000));
  const riskParams = options.riskParams ?? DEFAULT_ORDER_RISK_PARAMS;

  let ledger = emptyLedger("replay", "paper", options.openingCashUsd, quoteAsset);
  const startingEquityUsd = toNumber(options.openingCashUsd);
  const skipped: Record<string, number> = {};
  const skippedIds: ReplayResult["skippedIds"] = [];
  let executed = 0;
  let totalTokens = 0;
  let calls = 0;

  const note = (id: string, reason: ReplayRejection | "risk" | "no_fill") => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
    skippedIds.push({ id, reason });
  };

  const sorted = [...decisions].sort((a, b) => a.ts - b.ts);
  let lastPrices: Record<string, Dec> = {};

  for (const d of sorted) {
    if (d.llm) {
      calls++;
      totalTokens += d.llm.totalTokens ?? 0;
    }

    const validation = validateForReplay(d, {
      nowMs: options.nowMs,
      allowedSymbols: options.allowedSymbols,
      maxRecordLagMs: options.maxRecordLagMs,
    });
    if (!validation.ok) {
      note(d.id, validation.reason!);
      continue;
    }

    // A döntéskori árak a mark-to-markethez is kellenek.
    lastPrices = Object.fromEntries(Object.entries(d.ref!.prices).map(([s, p]) => [s, dec(p)]));
    if (d.action === "HOLD" || !d.symbol) continue;

    const price = lastPrices[d.symbol];
    const ctx: OrderRiskContext = {
      ledger,
      prices: lastPrices,
      reservedQuoteBySymbol: {},
      reservedQuoteTotal: ZERO,
      dailyLossLatched: false,
      dayBaselineMissing: false,
      allowedSymbols: options.allowedSymbols,
      quoteAsset,
    };

    const verdict =
      d.action === "BUY"
        ? evaluateOrder(
            { side: "BUY", symbol: d.symbol, desiredQuote: mul(equityAt(ledger, lastPrices, quoteAsset), dec(d.amountPct)) },
            ctx,
            riskParams,
          )
        : evaluateOrder(
            { side: "SELL", symbol: d.symbol, baseQty: mul(positionQty(ledger, d.symbol), dec(d.amountPct)) },
            ctx,
            riskParams,
          );
    if (!verdict.allowed) {
      note(d.id, "risk");
      continue;
    }

    // Fill a döntéskori áron, csúszással és díjjal — ugyanaz a modell, mint a paperben.
    const fillPrice = d.action === "BUY" ? mul(price, add("1", slip)) : mul(price, add("1", `-${slip}`));
    let qty: Dec;
    let gross: Dec;
    let fee: Dec;
    if (verdict.order.side === "BUY") {
      gross = div(verdict.order.maxQuoteSpend, add("1", feePct));
      fee = mul(gross, feePct);
      qty = div(gross, fillPrice);
    } else {
      qty = verdict.order.baseQty;
      gross = mul(qty, fillPrice);
      fee = mul(gross, feePct);
    }
    if (!isPositive(qty) || !isPositive(gross)) {
      note(d.id, "no_fill");
      continue;
    }

    const orderId = `replay-${d.id}`;
    const fill: Fill = {
      fillId: fillKey("paper", orderId, "1"),
      intentId: orderId,
      portfolioId: "replay",
      mode: "paper",
      symbol: d.symbol,
      side: d.action,
      exchangeOrderId: orderId,
      exchangeTradeId: "1",
      filledBaseQty: qty,
      grossQuoteAmount: gross,
      fillPrice,
      feeAmount: fee,
      feeAsset: quoteAsset,
      executedAt: d.ts,
    };
    const result = applyFill(ledger, fill, { quoteAsset });
    if (!result.applied) {
      note(d.id, "no_fill");
      continue;
    }
    ledger = result.state;
    executed++;
  }

  const llmCostUsd = ((options.llmCostPer1kTokens ?? 0) * totalTokens) / 1000;
  return {
    ledger,
    startingEquityUsd,
    endingEquityUsd: toNumber(equityAt(ledger, lastPrices, quoteAsset)),
    executed,
    skipped,
    skippedIds,
    cost: { llmCostUsd, totalTokens, calls },
  };
}

/**
 * AI NÉLKÜLI kontroll UGYANAZON a feltételrendszeren: ugyanaz a kezdőtőke, ugyanazok az
 * árak és ugyanaz a kapu, de EGYETLEN AI-intent sem hajtódik végre.
 *
 * Ez a helyes összehasonlítási alap: az AI hozzáadott értéke a kettő KÜLÖNBSÉGE, nem az
 * AI önmagában mért hozama.
 */
export function replayWithoutAi(decisions: RecordedDecision[], options: ReplayOptions): ReplayResult {
  const held = decisions.map((d) => ({ ...d, action: "HOLD" as const, symbol: null, amountPct: 0 }));
  const r = replayDecisions(held, options);
  // Az AI-költség a kontrollnál definíció szerint nulla.
  return { ...r, cost: { llmCostUsd: 0, totalTokens: 0, calls: 0 } };
}

export interface AiValueReport {
  withAi: ReplayResult;
  withoutAi: ReplayResult;
  /** A kettő közti különbség USD-ben, az AI-költség UTÁN. */
  netAiValueUsd: number;
  /** Igaz, ha a minta annyira szűk, hogy nem eldönthető. */
  inconclusive: boolean;
  reason?: string;
}

/**
 * Az AI nettó hozzáadott értéke. Kevés végrehajtott döntésnél NEM ELDÖNTHETŐ —
 * néhány kötésből nem lehet előnyre következtetni.
 */
export function compareAiValue(
  decisions: RecordedDecision[],
  options: ReplayOptions,
  minExecuted = 30,
): AiValueReport {
  const withAi = replayDecisions(decisions, options);
  const withoutAi = replayWithoutAi(decisions, options);
  const netAiValueUsd = withAi.endingEquityUsd - withoutAi.endingEquityUsd - withAi.cost.llmCostUsd;
  const inconclusive = withAi.executed < minExecuted;
  return {
    withAi,
    withoutAi,
    netAiValueUsd,
    inconclusive,
    reason: inconclusive
      ? `Csak ${withAi.executed} végrehajtott AI-döntés (< ${minExecuted}) — NEM ELDÖNTHETŐ, nem eredmény.`
      : undefined,
  };
}

/** Segéd: a rögzített döntések lefedettsége (mennyi játszható vissza egyáltalán). */
export function replayCoverage(
  decisions: RecordedDecision[],
  opts: ValidateOptions,
): { total: number; replayable: number; byReason: Record<string, number> } {
  const byReason: Record<string, number> = {};
  let replayable = 0;
  for (const d of decisions) {
    const v = validateForReplay(d, opts);
    if (v.ok) replayable++;
    else byReason[v.reason!] = (byReason[v.reason!] ?? 0) + 1;
  }
  return { total: decisions.length, replayable, byReason };
}

export { cashOf };

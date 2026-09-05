import type { RawDecision, Decision } from "@/lib/types";
import {
  type Dec,
  ZERO,
  add,
  sub,
  mul,
  div,
  min as decMin,
  max as decMax,
  gt,
  gte,
  lt,
  lte,
  isPositive,
  dec,
  toNumber,
} from "@/lib/portfolio/money";
import type { ExecutionOrder } from "@/lib/execution/contracts";
import type { TradeOrigin } from "@/lib/engine/tick-process";
import { type LedgerState, cashOf, positionQty, equityAt } from "@/lib/portfolio/ledger";

/**
 * A Risk Manager MINDEN order közös kapuja (T06).
 *
 * Az audit §1 bizonyította: a régi kapu csak az ÚJ döntés százalékát nézte, a meglévő
 * pozíció értékét nem. 100 USD equity, 20 USD BTC és 80 USD cash mellett egy 20%-os BUY
 * 16 USD vételt engedett át, azaz 36%-os BTC-kitettséget. Ráadásul a nagy BUY
 * visszavágásakor a függvény azonnal visszatért, így a pozíciószám-ellenőrzést átugrotta.
 *
 * A v2 kapu:
 *  - MINDEN feltételt kiértékel, nincs korai visszatérés;
 *  - a szabad keret `max(0, equity * maxPositionPct − meglévő érték − foglalás)`;
 *  - a DCA, a momentum, az AI és a kézi végrehajtás UGYANIDE érkezik;
 *  - a SELL nem függ készpénztől, és a napi veszteségkapunál is engedett.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Döntés-szintű kapu (v1 alak, javított szemantikával)
// ─────────────────────────────────────────────────────────────────────────────

export interface RiskContext {
  cashUsd: number;
  positions: { symbol: string; valueUsd: number }[];
  totalEquity: () => number;
  /** Mai napi P&L % (circuit breakerhez). Pozitív = nyereség, negatív = veszteség. */
  dayPnlPct?: number;
  /**
   * Igaz, ha aznap már aktiválódott a veszteségkapu (latch). A latch a nap végéig tart,
   * akkor is, ha az equity időközben visszakúszott. Lásd day-equity.ts (T07).
   */
  dailyLossLatched?: boolean;
  /**
   * Igaz, ha nincs hiteles napkezdő referencia (kimaradt napnyitás). Ilyenkor NEM
   * találunk ki napi hozamot: az új BUY szünetel, a SELL és a védelem működik.
   */
  dayBaselineMissing?: boolean;
  /** Már beküldött, még nem teljesült BUY-ok lefoglalt kerete symbolonként. */
  reservedQuoteBySymbol?: Record<string, number>;
  /** Engedélyezett szimbólumok. Hiányzik → nincs szimbólum-szűrés ezen a szinten. */
  allowedSymbols?: string[];
}

export interface RiskParams {
  maxPositionPct: number;
  maxConcurrentPositions: number;
  dailyLossCircuitBreakerPct: number;
}

/**
 * Döntés-szintű kapu: a RawDecision-t validált Decision-né alakítja.
 *
 * FONTOS SZEMANTIKA-VÁLTÁS (v2): az `amountPct` BUY-nál a TELJES EQUITY hányada
 * (nem a készpénzé), SELL-nél a BIRTOKOLT MENNYISÉG hányada. A régi naplókat nem
 * szabad ezzel a jelentéssel újraértelmezni.
 *
 * Minden feltétel kiértékelődik; a korlátozások összeadódnak, nincs korai visszatérés.
 */
export function applyRisk(raw: RawDecision, ctx: RiskContext, params: RiskParams): Decision {
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  const base: Decision = { ...raw, id, timestamp, overridden: false };

  if (raw.action === "HOLD") return base;

  const reasons: string[] = [];
  let action: RawDecision["action"] = raw.action;
  let amountPct = raw.amountPct;

  const equity = ctx.totalEquity();
  const openSymbols = new Set(ctx.positions.map((p) => p.symbol));

  if (ctx.allowedSymbols && raw.symbol && !ctx.allowedSymbols.includes(raw.symbol)) {
    action = "HOLD";
    amountPct = 0;
    reasons.push(`A ${raw.symbol} nincs az engedélyezett kosárban.`);
  }

  if (raw.action === "SELL") {
    // A kockázatCSÖKKENTŐ zárás nem tiltható: sem készpénzhiány, sem napi kapu miatt.
    const held = ctx.positions.find((p) => p.symbol === raw.symbol);
    if (!held || held.valueUsd <= 0) {
      action = "HOLD";
      amountPct = 0;
      reasons.push(`Nincs nyitott ${raw.symbol} pozíció — eladás nem lehetséges.`);
    } else if (amountPct > 1) {
      amountPct = 1;
      reasons.push("Az eladási hányad legfeljebb a teljes pozíció (100%).");
    }
    return finish(base, action, amountPct, reasons, raw);
  }

  // ── BUY ────────────────────────────────────────────────────────────────────
  const latched = ctx.dailyLossLatched === true;
  const breached = (ctx.dayPnlPct ?? 0) <= -params.dailyLossCircuitBreakerPct;
  if (latched || breached) {
    action = "HOLD";
    amountPct = 0;
    reasons.push(
      latched
        ? "Napi veszteségkapu aktív (latch) — új vétel a következő UTC napig tiltott."
        : `Napi circuit breaker aktiválódott (${((ctx.dayPnlPct ?? 0) * 100).toFixed(1)}% ≤ -${(
            params.dailyLossCircuitBreakerPct * 100
          ).toFixed(0)}%)`,
    );
  }

  if (ctx.dayBaselineMissing) {
    action = "HOLD";
    amountPct = 0;
    reasons.push("Nincs hiteles napkezdő equity-referencia — új vétel szünetel.");
  }

  // Összesített pozíciólimit: a MEGLÉVŐ értéket és a foglalást is levonjuk.
  const existingValue = ctx.positions.find((p) => p.symbol === raw.symbol)?.valueUsd ?? 0;
  const reserved = ctx.reservedQuoteBySymbol?.[raw.symbol] ?? 0;
  const headroomUsd = Math.max(0, equity * params.maxPositionPct - existingValue - reserved);
  const headroomPct = equity > 0 ? headroomUsd / equity : 0;
  if (amountPct > headroomPct) {
    reasons.push(
      `Max pozíció ${(params.maxPositionPct * 100).toFixed(0)}% tőke — a ${raw.symbol} szabad kerete ` +
        `${headroomUsd.toFixed(2)} USD (meglévő ${existingValue.toFixed(2)}, foglalt ${reserved.toFixed(2)}).`,
    );
    amountPct = headroomPct;
  }

  // Készpénz-korlát: tőkeáttétel nincs.
  const cashPct = equity > 0 ? Math.max(0, ctx.cashUsd) / equity : 0;
  if (amountPct > cashPct) {
    reasons.push(`Készpénz-korlát: ${Math.max(0, ctx.cashUsd).toFixed(2)} USD áll rendelkezésre.`);
    amountPct = cashPct;
  }

  // Pozíciószám-korlát — akkor is fut, ha fentebb már vágtunk (nincs korai visszatérés).
  const isNewPosition = !!raw.symbol && !openSymbols.has(raw.symbol);
  if (isNewPosition && openSymbols.size >= params.maxConcurrentPositions) {
    action = "HOLD";
    amountPct = 0;
    reasons.push(`Max ${params.maxConcurrentPositions} egyidejű pozíció — új coin nyitás elutasítva.`);
  }

  if (action === "BUY" && amountPct <= 0) {
    action = "HOLD";
    amountPct = 0;
    if (reasons.length === 0) reasons.push("Nem maradt szabad keret.");
  }

  return finish(base, action, amountPct, reasons, raw);
}

function finish(
  base: Decision,
  action: RawDecision["action"],
  amountPct: number,
  reasons: string[],
  raw: RawDecision,
): Decision {
  const changed = action !== raw.action || Math.abs(amountPct - raw.amountPct) > 1e-12;
  if (!changed) return base;
  return {
    ...base,
    action,
    amountPct,
    overridden: true,
    overrideReason: reasons.join(" "),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Végrehajtás-szintű kapu (a hiteles, decimális ellenőrzés minden order előtt)
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderRiskContext {
  ledger: LedgerState;
  /** Mark-to-market árak. Hiányzó ár esetén az adott pozíció nem számít az equitybe. */
  prices: Record<string, Dec>;
  /** Beküldött, még nem teljesült BUY-ok lefoglalt kerete symbolonként. */
  reservedQuoteBySymbol: Record<string, Dec>;
  /** Az összes aktív foglalás (készpénz-fedezethez). */
  reservedQuoteTotal: Dec;
  /** Eredet-specifikus keret (pl. heti DCA-maradék). undefined = nincs külön keret. */
  originBudgetQuote?: Dec;
  dailyLossLatched: boolean;
  dayBaselineMissing: boolean;
  allowedSymbols: string[];
  quoteAsset?: string;
}

export interface OrderRiskParams {
  maxPositionPct: Dec;
  maxConcurrentPositions: number;
  /** Minimum kötésérték quote-ban; ez alatt nincs order (tőzsdei minimum notional). */
  minOrderQuote: Dec;
  /** Készpénz-tartalék a díjra (0.001 = 0,1%), hogy a fill ne fusson fedezethiányba. */
  feeReservePct: Dec;
}

export type RiskRejectCode =
  | "symbol_not_allowed"
  | "daily_loss_latched"
  | "day_baseline_missing"
  | "max_positions"
  | "no_headroom"
  | "insufficient_cash"
  | "origin_budget_exhausted"
  | "below_min_notional"
  | "no_position"
  | "zero_amount";

export type RiskVerdict =
  | { allowed: true; order: ExecutionOrder; adjusted: boolean; reasons: string[] }
  | { allowed: false; code: RiskRejectCode; reasons: string[] };

export const DEFAULT_ORDER_RISK_PARAMS: OrderRiskParams = {
  maxPositionPct: "0.2",
  maxConcurrentPositions: 3,
  minOrderQuote: "1",
  feeReservePct: "0.001",
};

/** Az adott symbol szabad kerete quote-ban: equity·maxPct − meglévő érték − foglalás. */
export function positionHeadroom(
  symbol: string,
  ctx: OrderRiskContext,
  params: OrderRiskParams,
): { headroom: Dec; equity: Dec; existingValue: Dec; reserved: Dec } {
  const equity = equityAt(ctx.ledger, ctx.prices, ctx.quoteAsset ?? "USDT");
  const price = ctx.prices[symbol];
  const qty = positionQty(ctx.ledger, symbol);
  const existingValue = price ? mul(qty, price) : ZERO;
  const reserved = ctx.reservedQuoteBySymbol[symbol] ?? ZERO;
  const cap = mul(equity, params.maxPositionPct);
  const headroom = decMax(ZERO, sub(sub(cap, existingValue), reserved));
  return { headroom, equity, existingValue, reserved };
}

/**
 * A hiteles kapu MINDEN order előtt. A BUY felső korlátja a legkisebb az alábbiakból:
 * elérhető készpénz (díjtartalékkal és foglalással csökkentve), a kívánt összeg, a
 * pozíció szabad kerete és az eredet-specifikus keret.
 */
export function evaluateOrder(
  request: { side: "BUY"; symbol: string; desiredQuote: Dec } | { side: "SELL"; symbol: string; baseQty: Dec },
  ctx: OrderRiskContext,
  params: OrderRiskParams = DEFAULT_ORDER_RISK_PARAMS,
): RiskVerdict {
  const reasons: string[] = [];
  const quoteAsset = ctx.quoteAsset ?? "USDT";

  if (!ctx.allowedSymbols.includes(request.symbol)) {
    return { allowed: false, code: "symbol_not_allowed", reasons: [`A ${request.symbol} nincs az engedélyezett kosárban.`] };
  }

  // ── SELL: nem függ készpénztől, és a napi kapunál is engedett ───────────────
  if (request.side === "SELL") {
    const held = positionQty(ctx.ledger, request.symbol);
    if (!isPositive(held)) {
      return { allowed: false, code: "no_position", reasons: [`Nincs birtokolt ${request.symbol} — eladás tiltott.`] };
    }
    if (!isPositive(request.baseQty)) {
      return { allowed: false, code: "zero_amount", reasons: ["Nulla eladási mennyiség."] };
    }
    let qty = request.baseQty;
    let adjusted = false;
    if (gt(qty, held)) {
      reasons.push(`Az eladás a birtokolt ${held} mennyiségre vágva.`);
      qty = held;
      adjusted = true;
    }
    return { allowed: true, order: { side: "SELL", symbol: request.symbol, baseQty: qty }, adjusted, reasons };
  }

  // ── BUY ────────────────────────────────────────────────────────────────────
  if (ctx.dailyLossLatched) {
    return {
      allowed: false,
      code: "daily_loss_latched",
      reasons: ["Napi veszteségkapu aktív — új vétel a következő UTC napig tiltott."],
    };
  }
  if (ctx.dayBaselineMissing) {
    return {
      allowed: false,
      code: "day_baseline_missing",
      reasons: ["Nincs hiteles napkezdő equity-referencia — új vétel szünetel."],
    };
  }
  if (!isPositive(request.desiredQuote)) {
    return { allowed: false, code: "zero_amount", reasons: ["Nulla vételi összeg."] };
  }

  const openSymbols = Object.keys(ctx.ledger.positions).filter((s) => isPositive(ctx.ledger.positions[s].qty));
  const isNew = !openSymbols.includes(request.symbol);
  if (isNew && openSymbols.length >= params.maxConcurrentPositions) {
    return {
      allowed: false,
      code: "max_positions",
      reasons: [`Max ${params.maxConcurrentPositions} egyidejű pozíció — új coin nyitás elutasítva.`],
    };
  }

  const { headroom, existingValue, reserved } = positionHeadroom(request.symbol, ctx, params);
  // A díjtartalék miatt a fedezet a nyers készpénznél kevesebb.
  const cash = cashOf(ctx.ledger, quoteAsset);
  const freeCash = decMax(ZERO, sub(cash, ctx.reservedQuoteTotal));
  const cashCap = div(freeCash, add("1", params.feeReservePct));

  let allowedQuote = request.desiredQuote;
  const clampTo = (cap: Dec, reason: string) => {
    if (lt(cap, allowedQuote)) {
      allowedQuote = cap;
      reasons.push(reason);
    }
  };

  clampTo(
    headroom,
    `Pozíciólimit: a ${request.symbol} szabad kerete ${headroom} (meglévő ${existingValue}, foglalt ${reserved}).`,
  );
  clampTo(cashCap, `Készpénz-korlát: ${freeCash} szabad, díjtartalékkal ${cashCap}.`);
  if (ctx.originBudgetQuote !== undefined) {
    clampTo(ctx.originBudgetQuote, `Eredet-keret: ${ctx.originBudgetQuote} maradt.`);
  }

  if (!isPositive(allowedQuote)) {
    const code: RiskRejectCode = lte(headroom, ZERO)
      ? "no_headroom"
      : ctx.originBudgetQuote !== undefined && lte(ctx.originBudgetQuote, ZERO)
        ? "origin_budget_exhausted"
        : "insufficient_cash";
    return { allowed: false, code, reasons: reasons.length ? reasons : ["Nem maradt szabad keret."] };
  }

  if (lt(allowedQuote, params.minOrderQuote)) {
    return {
      allowed: false,
      code: "below_min_notional",
      reasons: [...reasons, `A kötésérték ${allowedQuote} a minimum ${params.minOrderQuote} alatt van.`],
    };
  }

  return {
    allowed: true,
    order: { side: "BUY", symbol: request.symbol, maxQuoteSpend: allowedQuote },
    adjusted: reasons.length > 0,
    reasons,
  };
}

/** Az eredet-specifikus keret kiválasztása (a DCA-t a heti keret fékezi, az AI-t nem). */
export function originBudgetFor(
  origin: TradeOrigin,
  budgets: { weeklyDcaRemaining?: Dec },
): Dec | undefined {
  return origin === "dca" ? budgets.weeklyDcaRemaining : undefined;
}

/** Kényelmi átváltás: a döntés-szintű hányadból quote-összeg az equity alapján. */
export function quoteFromEquityFraction(equity: Dec, fraction: number): Dec {
  if (!Number.isFinite(fraction) || fraction <= 0) return ZERO;
  return mul(equity, dec(fraction));
}

/** Kényelmi átváltás: a Dec equity numberként a régi (v1) kontextushoz. */
export function equityAsNumber(state: LedgerState, prices: Record<string, Dec>): number {
  return toNumber(equityAt(state, prices));
}

/** A ledger állapotából a döntés-szintű RiskContext (mark-to-market értékekkel). */
export function riskContextFromLedger(
  ledger: LedgerState,
  prices: Record<string, Dec>,
  extra: {
    dayPnlPct?: number;
    dailyLossLatched?: boolean;
    dayBaselineMissing?: boolean;
    reservedQuoteBySymbol?: Record<string, Dec>;
    allowedSymbols?: string[];
    quoteAsset?: string;
  } = {},
): RiskContext {
  const quoteAsset = extra.quoteAsset ?? "USDT";
  const positions = Object.values(ledger.positions).map((p) => ({
    symbol: p.symbol,
    valueUsd: prices[p.symbol] ? toNumber(mul(p.qty, prices[p.symbol])) : 0,
  }));
  const cashUsd = toNumber(cashOf(ledger, quoteAsset));
  const reservedQuoteBySymbol = Object.fromEntries(
    Object.entries(extra.reservedQuoteBySymbol ?? {}).map(([k, v]) => [k, toNumber(v)]),
  );
  return {
    cashUsd,
    positions,
    totalEquity: () => cashUsd + positions.reduce((s, p) => s + p.valueUsd, 0),
    dayPnlPct: extra.dayPnlPct,
    dailyLossLatched: extra.dailyLossLatched,
    dayBaselineMissing: extra.dayBaselineMissing,
    reservedQuoteBySymbol,
    allowedSymbols: extra.allowedSymbols,
  };
}

/** Segéd az összes aktív foglalás összegzéséhez. */
export function totalReserved(reservedBySymbol: Record<string, Dec>): Dec {
  return Object.values(reservedBySymbol).reduce((s, v) => add(s, v), ZERO);
}

/** Igaz, ha az adott verdict ténylegesen engedélyez kötést. */
export const isAllowed = (v: RiskVerdict): v is Extract<RiskVerdict, { allowed: true }> => v.allowed;

/** Csak olvasható segéd a teszteknek és a naplózáshoz. */
export const decMinAll = (values: Dec[]): Dec => values.reduce((a, b) => decMin(a, b));

export { gte as decGte };

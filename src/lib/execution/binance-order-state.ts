/**
 * Binance order-állapot és fill-leképezés (T25).
 *
 * Amit az audit A. szakasza kifogásolt, és itt megoldunk:
 *  - STABIL client order ID: ugyanaz az intent MINDIG ugyanazt az azonosítót kapja, ezért
 *    a timeout utáni újrapróbálás nem hoz létre második megbízást;
 *  - a timeout NEM sikertelenség: ismeretlen állapot, amit LEKÉRDEZÉSSEL kell tisztázni;
 *  - a részleges teljesülés és a nulla fill NEM hamis teljes siker;
 *  - a díj a SAJÁT eszközében marad (BNB, base vagy quote) — nem számoljuk át USD-re,
 *    így nem vonódik le kétszer; a hiányzó díjárfolyam FÜGGŐ ÉRTÉKELÉS, nem nulla.
 *
 * Tiszta függvények: nincs IO, nincs Date.now.
 */
import { type Dec, ZERO, add, div, isPositive, dec } from "@/lib/portfolio/money";
import { fillKey, type ExecutionIntent, type Fill, type OrderState } from "./contracts";

/** A Binance order-válasz mezői, amikre támaszkodunk. */
export interface BinanceOrderPayload {
  orderId?: number | string;
  clientOrderId?: string;
  origClientOrderId?: string;
  status?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  transactTime?: number;
  updateTime?: number;
  time?: number;
  fills?: BinanceTradePayload[];
}

/** Egy tényleges teljesülés (order-válasz `fills` tömbjéből vagy a myTrades végpontból). */
export interface BinanceTradePayload {
  id?: number | string;
  tradeId?: number | string;
  orderId?: number | string;
  price?: string;
  qty?: string;
  quoteQty?: string;
  commission?: string;
  commissionAsset?: string;
  time?: number;
  isBuyer?: boolean;
}

/** A Binance státusz leképezése a saját szerződésünkre. Ismeretlen státusz → `unknown`. */
export function mapStatus(status: string | undefined): OrderState {
  switch (status) {
    case "NEW":
    case "PENDING_NEW":
    case "ACCEPTED":
      return "pending";
    case "PARTIALLY_FILLED":
      return "partially_filled";
    case "FILLED":
      return "filled";
    case "CANCELED":
    case "PENDING_CANCEL":
      return "canceled";
    case "REJECTED":
      return "rejected";
    case "EXPIRED":
    case "EXPIRED_IN_MATCH":
      return "expired";
    default:
      return "unknown";
  }
}

export interface FeeInfo {
  amount: Dec;
  asset: string;
  /**
   * Igaz, ha a díj eszközének USD-értéke NEM ismert ebből a válaszból. Ilyenkor a díj a
   * SAJÁT eszközében kerül könyvelésre, az USD-értékelés pedig FÜGGŐ marad — nem nulla.
   */
  valuationPending: boolean;
}

/** A díj kiolvasása. A hiányzó díjeszköz a quote-ot feltételezi, de jelöli a bizonytalanságot. */
export function feeOf(trade: BinanceTradePayload, quoteAsset: string, baseAsset: string): FeeInfo {
  const amount = trade.commission !== undefined ? dec(trade.commission) : ZERO;
  const asset = trade.commissionAsset ?? quoteAsset;
  const known = asset === quoteAsset || asset === baseAsset;
  return { amount, asset, valuationPending: !known && isPositive(amount) };
}

export interface MapFillsResult {
  fills: Fill[];
  /** Azok a teljesülések, ahol a díj eszközének értékelése FÜGGŐ. */
  pendingFeeValuations: { fillId: string; asset: string; amount: Dec }[];
  /** Miért maradt ki egy sor (a néma adatvesztés helyett). */
  skipped: { reason: "zero_qty" | "missing_ids" | "zero_price"; tradeId: string }[];
}

/**
 * Tőzsdei teljesülések → szerződéses Fill-ek.
 *
 * A `fillId` a (mode, orderId, tradeId) hármasból képződik, ezért ugyanaz a teljesülés
 * kétszer beolvasva sem könyvelődik kétszer. A nulla mennyiségű sor NEM fill.
 */
export function mapFills(
  payload: BinanceOrderPayload,
  intent: ExecutionIntent,
  opts: { quoteAsset?: string; baseAsset?: string } = {},
): MapFillsResult {
  const quoteAsset = opts.quoteAsset ?? "USDT";
  const baseAsset = opts.baseAsset ?? intent.order.symbol;
  const orderId = payload.orderId !== undefined ? String(payload.orderId) : null;
  const executedAt = payload.transactTime ?? payload.updateTime ?? payload.time ?? intent.expiresAt;

  const fills: Fill[] = [];
  const pendingFeeValuations: MapFillsResult["pendingFeeValuations"] = [];
  const skipped: MapFillsResult["skipped"] = [];
  const seen = new Set<string>();

  for (const t of payload.fills ?? []) {
    const tradeId = t.tradeId !== undefined ? String(t.tradeId) : t.id !== undefined ? String(t.id) : null;
    const effectiveOrderId = orderId ?? (t.orderId !== undefined ? String(t.orderId) : null);
    if (!effectiveOrderId || !tradeId) {
      skipped.push({ reason: "missing_ids", tradeId: String(tradeId ?? "?") });
      continue;
    }
    const qty = t.qty !== undefined ? dec(t.qty) : ZERO;
    if (!isPositive(qty)) {
      skipped.push({ reason: "zero_qty", tradeId });
      continue;
    }
    const price = t.price !== undefined ? dec(t.price) : ZERO;
    const gross = t.quoteQty !== undefined ? dec(t.quoteQty) : isPositive(price) ? dec(String(Number(qty) * Number(price))) : ZERO;
    if (!isPositive(gross) || !isPositive(price)) {
      skipped.push({ reason: "zero_price", tradeId });
      continue;
    }

    const key = fillKey(intent.mode, effectiveOrderId, tradeId);
    if (seen.has(key)) continue;
    seen.add(key);

    const fee = feeOf(t, quoteAsset, baseAsset);
    if (fee.valuationPending) {
      pendingFeeValuations.push({ fillId: key, asset: fee.asset, amount: fee.amount });
    }

    fills.push({
      fillId: key,
      intentId: intent.intentId,
      portfolioId: intent.portfolioId,
      mode: intent.mode,
      symbol: intent.order.symbol,
      side: intent.order.side,
      exchangeOrderId: effectiveOrderId,
      exchangeTradeId: tradeId,
      filledBaseQty: qty,
      grossQuoteAmount: gross,
      fillPrice: price,
      feeAmount: fee.amount,
      feeAsset: fee.asset,
      executedAt: t.time ?? executedAt,
    });
  }

  return { fills, pendingFeeValuations, skipped };
}

/** Az összes teljesült mennyiség a fillekből (a payload executedQty-jétől függetlenül). */
export function totalFilledQty(fills: Fill[]): Dec {
  return fills.reduce((s, f) => add(s, f.filledBaseQty), ZERO);
}

/** Átlagos teljesülési ár a fillekből. Nulla mennyiségnél null — nincs kitalált ár. */
export function averageFillPrice(fills: Fill[]): Dec | null {
  const qty = totalFilledQty(fills);
  if (!isPositive(qty)) return null;
  const gross = fills.reduce((s, f) => add(s, f.grossQuoteAmount), ZERO);
  return div(gross, qty);
}

export interface ReconciledOrder {
  state: OrderState;
  fills: Fill[];
  pendingFeeValuations: MapFillsResult["pendingFeeValuations"];
  exchangeOrderId: string | null;
  /** Igaz, ha a tőzsde állapota szerint az order MÉG nyitott (lehet még fill). */
  open: boolean;
  message?: string;
}

/**
 * Egy order-válasz értelmezése. A LÉNYEG: az állapot és a fillek KÜLÖN dolgok —
 * `FILLED` státusz nulla fillel sem hamis siker, és `PARTIALLY_FILLED` sem az.
 */
export function interpretOrder(
  payload: BinanceOrderPayload,
  intent: ExecutionIntent,
  opts: { quoteAsset?: string; baseAsset?: string } = {},
): ReconciledOrder {
  const state = mapStatus(payload.status);
  const mapped = mapFills(payload, intent, opts);
  const filled = totalFilledQty(mapped.fills);

  let effectiveState = state;
  if (state === "filled" && !isPositive(filled)) {
    // FILLED státusz, de egyetlen teljesülés sincs a válaszban → NEM tekintjük sikernek.
    effectiveState = "unknown";
  }
  return {
    state: effectiveState,
    fills: mapped.fills,
    pendingFeeValuations: mapped.pendingFeeValuations,
    exchangeOrderId: payload.orderId !== undefined ? String(payload.orderId) : null,
    // Az `unknown` is NYITOTT: amíg nem tisztáztuk, nem hagyhatjuk lezártnak.
    open: effectiveState === "pending" || effectiveState === "partially_filled" || effectiveState === "unknown",
    message:
      effectiveState === "unknown" && state === "filled"
        ? "A tőzsde FILLED státuszt adott, de nem érkezett teljesülés-sor — egyeztetés szükséges."
        : undefined,
  };
}

/** Timeout vagy hálózati hiba → ISMERETLEN állapot, NEM elutasítás. */
export function unknownFromError(error: unknown): ReconciledOrder {
  return {
    state: "unknown",
    fills: [],
    pendingFeeValuations: [],
    exchangeOrderId: null,
    open: true,
    message: `A megbízás kimenetele ismeretlen: ${String(error)}. Lekérdezés szükséges, ÚJ order NEM küldhető.`,
  };
}

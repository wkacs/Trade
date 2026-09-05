/**
 * Verziózott végrehajtási szerződés (T02) — order, intent és fill.
 *
 * MIÉRT: a régi `Order { side, symbol, amountUsd }` kétértelmű volt. BUY-nál az
 * `amountUsd` költendő quote-összeget jelentett, SELL-nél viszont a tick a
 * `cashUsd * amountPct`-ből képezte, vagyis az ELADÁS mérete a KÉSZPÉNZTŐL függött.
 * Cash≈0 mellett az AI nem tudott érdemben eladni (audit §2).
 *
 * A v2 ezt a kétértelműséget típusszinten szünteti meg:
 *   BUY  → `maxQuoteSpend` (legfeljebb ennyi USDT-t költünk, díjjal együtt)
 *   SELL → `baseQty`       (ennyi coint adunk el; a készpénz nem játszik)
 *
 * Minden intent hordozza: portfolioId, mode, strategyVersion, origin, intentId, lejárat.
 * A paper és a live számla így nem oszthat könyvelési sorokat.
 *
 * Az értékek decimális SZÖVEGEK (lásd money.ts) — nincs lebegőpontos pénzügyi számítás.
 */
import { type Dec, isDecimalString, gt, gte, isPositive, div, mul, toNumber } from "@/lib/portfolio/money";
import type { TradeOrigin } from "@/lib/engine/tick-process";

/** A szerződés verziója. A régi (v1) naplókat NEM szabad v2 jelentéssel újraolvasni. */
export const EXECUTION_CONTRACT_VERSION = 2 as const;

export type TradingMode = "paper" | "live";

/** Végrehajtási order — az oldal dönti el, mit jelent a mennyiség. */
export type ExecutionOrder =
  | { side: "BUY"; symbol: string; maxQuoteSpend: Dec }
  | { side: "SELL"; symbol: string; baseQty: Dec };

/** Minden orderhez tartozó azonosító- és hatókör-adat. */
export interface IntentMeta {
  /** Egyedi, a hívó által generált azonosító — ez lesz a stabil client order ID magja. */
  intentId: string;
  portfolioId: string;
  mode: TradingMode;
  /** A döntést hozó stratégia verziója (StrategyConfig version) a naplók értelmezéséhez. */
  strategyVersion: string;
  origin: TradeOrigin;
  /** Epoch ms — ezután az intent NEM hajtható végre (elavult ár, kihagyott ciklus). */
  expiresAt: number;
  contractVersion: typeof EXECUTION_CONTRACT_VERSION;
}

export interface ExecutionIntent extends IntentMeta {
  order: ExecutionOrder;
  /** Az intent képzésekor érvényes referencia-ár (naplózás, becslés; nem fill-ár). */
  referencePrice: Dec;
}

/**
 * Egy order tőzsdei állapota. Az `unknown` kulcsfontosságú: timeout után nem tudjuk,
 * teljesült-e — ilyenkor lekérdezés jár, nem új order új azonosítóval.
 */
export type OrderState =
  | "pending"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  | "unknown";

/** Egy TÉNYLEGES teljesülés. Sikertelen vagy nyitott order nem fill. */
export interface Fill {
  /** Egyedi kulcs a dedupláláshoz: mód + tőzsdei order- és trade-azonosító. */
  fillId: string;
  intentId: string;
  portfolioId: string;
  mode: TradingMode;
  symbol: string;
  side: "BUY" | "SELL";
  /** A tőzsde order-azonosítója (paperben szintetikus, de akkor is stabil). */
  exchangeOrderId: string;
  /** A tőzsde trade-azonosítója; egy order több trade-ből is teljesülhet. */
  exchangeTradeId: string;
  /** Ténylegesen teljesült base mennyiség (coin). */
  filledBaseQty: Dec;
  /** A teljesülés BRUTTÓ quote-értéke (qty × ár), díj nélkül. */
  grossQuoteAmount: Dec;
  /** Átlagos teljesülési ár = grossQuoteAmount / filledBaseQty. */
  fillPrice: Dec;
  /** A díj MENNYISÉGE a saját eszközében (nem USD-re átszámítva). */
  feeAmount: Dec;
  /** A díj eszköze: quote (USDT), base (a coin) vagy harmadik (pl. BNB). */
  feeAsset: string;
  /** Tényleges tőzsdei végrehajtási idő (epoch ms), nem a helyi feldolgozás ideje. */
  executedAt: number;
}

export class ContractError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

const SYMBOL_RE = /^[A-Z0-9]{2,16}$/;

function requirePositiveDec(value: unknown, field: string): Dec {
  if (!isDecimalString(value)) {
    throw new ContractError(`${field}: érvénytelen decimális érték (${JSON.stringify(value)})`, field);
  }
  if (!isPositive(value)) {
    throw new ContractError(`${field}: pozitív értéket vár, kapott ${value}`, field);
  }
  return value;
}

function requireNonNegativeDec(value: unknown, field: string): Dec {
  if (!isDecimalString(value)) {
    throw new ContractError(`${field}: érvénytelen decimális érték (${JSON.stringify(value)})`, field);
  }
  if (!gte(value, "0")) {
    throw new ContractError(`${field}: nem lehet negatív, kapott ${value}`, field);
  }
  return value;
}

function requireSymbol(value: unknown, field: string): string {
  if (typeof value !== "string" || !SYMBOL_RE.test(value)) {
    throw new ContractError(`${field}: érvénytelen szimbólum (${JSON.stringify(value)})`, field);
  }
  return value;
}

/** Validálja az ordert. Az ellentétes oldal mezője NEM fogadható el (kétértelműség tiltva). */
export function validateOrder(order: unknown): ExecutionOrder {
  if (!order || typeof order !== "object") throw new ContractError("order: hiányzik", "order");
  const o = order as Record<string, unknown>;
  const symbol = requireSymbol(o.symbol, "order.symbol");
  if (o.side === "BUY") {
    if ("baseQty" in o) {
      throw new ContractError("order: BUY-nál a baseQty értelmetlen (maxQuoteSpend kell)", "order.baseQty");
    }
    return { side: "BUY", symbol, maxQuoteSpend: requirePositiveDec(o.maxQuoteSpend, "order.maxQuoteSpend") };
  }
  if (o.side === "SELL") {
    if ("maxQuoteSpend" in o) {
      throw new ContractError("order: SELL-nél a maxQuoteSpend értelmetlen (baseQty kell)", "order.maxQuoteSpend");
    }
    return { side: "SELL", symbol, baseQty: requirePositiveDec(o.baseQty, "order.baseQty") };
  }
  throw new ContractError(`order.side: BUY vagy SELL kell, kapott ${JSON.stringify(o.side)}`, "order.side");
}

/** Validálja a teljes intentet (order + azonosítók + lejárat). */
export function validateIntent(intent: unknown): ExecutionIntent {
  if (!intent || typeof intent !== "object") throw new ContractError("intent: hiányzik", "intent");
  const i = intent as Record<string, unknown>;
  if (i.contractVersion !== EXECUTION_CONTRACT_VERSION) {
    throw new ContractError(
      `intent.contractVersion: ${EXECUTION_CONTRACT_VERSION} kell, kapott ${JSON.stringify(i.contractVersion)}`,
      "intent.contractVersion",
    );
  }
  for (const field of ["intentId", "portfolioId", "strategyVersion", "origin"] as const) {
    if (typeof i[field] !== "string" || (i[field] as string).length === 0) {
      throw new ContractError(`intent.${field}: nem üres szöveg kell`, `intent.${field}`);
    }
  }
  if (i.mode !== "paper" && i.mode !== "live") {
    throw new ContractError(`intent.mode: paper vagy live kell, kapott ${JSON.stringify(i.mode)}`, "intent.mode");
  }
  if (typeof i.expiresAt !== "number" || !Number.isFinite(i.expiresAt)) {
    throw new ContractError("intent.expiresAt: véges epoch ms kell", "intent.expiresAt");
  }
  return {
    intentId: i.intentId as string,
    portfolioId: i.portfolioId as string,
    mode: i.mode,
    strategyVersion: i.strategyVersion as string,
    origin: i.origin as TradeOrigin,
    expiresAt: i.expiresAt,
    contractVersion: EXECUTION_CONTRACT_VERSION,
    order: validateOrder(i.order),
    referencePrice: requirePositiveDec(i.referencePrice, "intent.referencePrice"),
  };
}

/** Lejárt-e az intent az adott (injektált) időben? */
export function isIntentExpired(intent: ExecutionIntent, nowMs: number): boolean {
  return nowMs > intent.expiresAt;
}

/** Validálja a fillt. Nulla mennyiségű "teljesülés" nem fill. */
export function validateFill(fill: unknown): Fill {
  if (!fill || typeof fill !== "object") throw new ContractError("fill: hiányzik", "fill");
  const f = fill as Record<string, unknown>;
  for (const field of [
    "fillId",
    "intentId",
    "portfolioId",
    "exchangeOrderId",
    "exchangeTradeId",
    "feeAsset",
  ] as const) {
    if (typeof f[field] !== "string" || (f[field] as string).length === 0) {
      throw new ContractError(`fill.${field}: nem üres szöveg kell`, `fill.${field}`);
    }
  }
  if (f.mode !== "paper" && f.mode !== "live") {
    throw new ContractError(`fill.mode: paper vagy live kell, kapott ${JSON.stringify(f.mode)}`, "fill.mode");
  }
  if (f.side !== "BUY" && f.side !== "SELL") {
    throw new ContractError(`fill.side: BUY vagy SELL kell, kapott ${JSON.stringify(f.side)}`, "fill.side");
  }
  if (typeof f.executedAt !== "number" || !Number.isFinite(f.executedAt)) {
    throw new ContractError("fill.executedAt: véges epoch ms kell", "fill.executedAt");
  }
  return {
    fillId: f.fillId as string,
    intentId: f.intentId as string,
    portfolioId: f.portfolioId as string,
    mode: f.mode,
    symbol: requireSymbol(f.symbol, "fill.symbol"),
    side: f.side,
    exchangeOrderId: f.exchangeOrderId as string,
    exchangeTradeId: f.exchangeTradeId as string,
    filledBaseQty: requirePositiveDec(f.filledBaseQty, "fill.filledBaseQty"),
    grossQuoteAmount: requirePositiveDec(f.grossQuoteAmount, "fill.grossQuoteAmount"),
    fillPrice: requirePositiveDec(f.fillPrice, "fill.fillPrice"),
    feeAmount: requireNonNegativeDec(f.feeAmount, "fill.feeAmount"),
    feeAsset: f.feeAsset as string,
    executedAt: f.executedAt,
  };
}

/** A fill dedup-kulcsa: mód + tőzsdei order- és trade-azonosító. */
export function fillKey(mode: TradingMode, exchangeOrderId: string, exchangeTradeId: string): string {
  return `${mode}:${exchangeOrderId}:${exchangeTradeId}`;
}

/**
 * Stabil client order ID az intentId-ból. Ugyanaz az intent MINDIG ugyanazt az azonosítót
 * kapja, így a timeout utáni újraküldés nem hoz létre második megbízást. A Binance
 * newClientOrderId legfeljebb 36 karakter lehet.
 */
export function clientOrderId(intentId: string): string {
  const cleaned = intentId.replace(/[^A-Za-z0-9_-]/g, "");
  return `zct-${cleaned}`.slice(0, 36);
}

// ── v1 ↔ v2 kompatibilitási adapter ──────────────────────────────────────────
// A régi runtime (tick.ts, PaperBroker, BinanceBroker) még a v1 Order-t használja.
// Amíg a T05/T06 át nem állítja, ezek az adapterek tartják a két alakot együtt.

/** Régi (v1) order alakja — amountUsd mindkét oldalon. */
export interface LegacyOrder {
  side: "BUY" | "SELL";
  symbol: string;
  amountUsd: number;
  stopLossPct: number;
}

/**
 * v1 → v2. SELL-nél a v1 nem hordozott mennyiséget, ezért az AKTUÁLIS ÁR kell hozzá:
 * baseQty = amountUsd / price. A konverzió szándékosan explicit — a régi kétértelmű
 * jelentést nem lehet ár nélkül feloldani.
 */
export function fromLegacyOrder(order: LegacyOrder, referencePrice: Dec): ExecutionOrder {
  const amount = requirePositiveDec(String(order.amountUsd), "legacyOrder.amountUsd");
  const symbol = requireSymbol(order.symbol, "legacyOrder.symbol");
  if (order.side === "BUY") return { side: "BUY", symbol, maxQuoteSpend: amount };
  const price = requirePositiveDec(referencePrice, "referencePrice");
  return { side: "SELL", symbol, baseQty: div(amount, price) };
}

/** v2 → v1. A régi brokerek USD-összeget várnak; SELL-nél qty × ár. */
export function toLegacyOrder(order: ExecutionOrder, referencePrice: Dec, stopLossPct: number): LegacyOrder {
  const amountUsd =
    order.side === "BUY" ? toNumber(order.maxQuoteSpend) : toNumber(mul(order.baseQty, referencePrice));
  return { side: order.side, symbol: order.symbol, amountUsd, stopLossPct };
}

/** Igaz, ha az érték ténylegesen fill-értékű (pozitív mennyiség és bruttó). */
export function isRealFill(f: { filledBaseQty: Dec; grossQuoteAmount: Dec }): boolean {
  return gt(f.filledBaseQty, "0") && gt(f.grossQuoteAmount, "0");
}

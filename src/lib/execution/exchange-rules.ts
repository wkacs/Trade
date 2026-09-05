/**
 * Tőzsdei szimbólum-szabályok (T24) — a Binance `exchangeInfo` szűrői.
 *
 * A régi BinanceBroker `.toFixed(2)`-vel kerekített árat és `.toString()`-gel mennyiséget,
 * és egy kitalált „stop-loss min 5%" szabályt kényszerített. Ez a kód:
 *  - a TÉNYLEGES `PRICE_FILTER.tickSize`, `LOT_SIZE.stepSize` és `NOTIONAL` értékekre
 *    kerekít (mennyiség és ár LEFELÉ, hogy a szűrő biztosan teljesüljön);
 *  - a minimum kötésértéket a tőzsdétől veszi, nem fix dollárból;
 *  - a paper és a backtest UGYANEZT az ellenőrzőt használhatja, ezért a 100 USD-s
 *    mérés is valósághű;
 *  - az elavult szűrőkészletet felismeri — nem küld ordert ismeretlen szabályokkal.
 *
 * Hivatkozás: binance-spot-api-docs/filters.md (PRICE_FILTER, LOT_SIZE, NOTIONAL).
 * A konkrét értékeket MINDIG az aktuális exchangeInfo adja, nem ez a fájl.
 */
import { type Dec, ZERO, add, sub, mul, div, gte, gt, lt, lte, isPositive, dec, floorToStep, round } from "@/lib/portfolio/money";

export interface SymbolFilters {
  /** A tőzsdei pár (pl. BTCUSDT). */
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  /** PRICE_FILTER */
  tickSize: Dec;
  minPrice: Dec;
  maxPrice: Dec | null;
  /** LOT_SIZE (market ordernél a MARKET_LOT_SIZE is számít) */
  stepSize: Dec;
  minQty: Dec;
  maxQty: Dec | null;
  marketStepSize: Dec | null;
  marketMinQty: Dec | null;
  marketMaxQty: Dec | null;
  /** NOTIONAL / MIN_NOTIONAL */
  minNotional: Dec;
  /** Igaz, ha a minimum notional a MARKET orderre is vonatkozik. */
  applyMinToMarket: boolean;
  /** Mikor kértük le — az elavult szűrőkészlet nem használható. */
  fetchedAt: number;
}

export type RuleViolation =
  | "unknown_symbol"
  | "not_trading"
  | "stale_filters"
  | "below_min_qty"
  | "above_max_qty"
  | "below_min_notional"
  | "price_out_of_range"
  | "zero_after_rounding";

export interface RuleCheck {
  ok: boolean;
  reason?: RuleViolation;
  message?: string;
}

/** Alapértelmezett szűrő-elévülés: ennél régebbi készlettel nem küldünk ordert. */
export const DEFAULT_FILTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface RawFilter {
  filterType: string;
  [key: string]: unknown;
}

const str = (v: unknown, fallback = "0"): Dec => {
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return dec(v);
  if (typeof v === "number" && Number.isFinite(v)) return dec(v);
  return fallback;
};

/**
 * Az `exchangeInfo` válasz feldolgozása. A hiányzó szűrőt NEM pótoljuk kitalált
 * értékkel — a hiányzó `stepSize` vagy `minNotional` esetén a symbol nem kereskedhető.
 */
export function parseExchangeInfo(
  payload: unknown,
  nowMs: number,
): { filters: Record<string, SymbolFilters>; skipped: { symbol: string; reason: string }[] } {
  const filters: Record<string, SymbolFilters> = {};
  const skipped: { symbol: string; reason: string }[] = [];
  const symbols = (payload as { symbols?: unknown[] })?.symbols;
  if (!Array.isArray(symbols)) return { filters, skipped: [{ symbol: "*", reason: "bad_payload" }] };

  for (const raw of symbols) {
    const s = raw as {
      symbol?: string;
      baseAsset?: string;
      quoteAsset?: string;
      status?: string;
      filters?: RawFilter[];
    };
    if (!s.symbol || !s.baseAsset || !s.quoteAsset) {
      skipped.push({ symbol: String(s.symbol ?? "?"), reason: "missing_fields" });
      continue;
    }
    const byType = new Map<string, RawFilter>();
    for (const f of s.filters ?? []) byType.set(f.filterType, f);

    const price = byType.get("PRICE_FILTER");
    const lot = byType.get("LOT_SIZE");
    const marketLot = byType.get("MARKET_LOT_SIZE");
    const notional = byType.get("NOTIONAL") ?? byType.get("MIN_NOTIONAL");

    if (!price || !lot || !notional) {
      skipped.push({ symbol: s.symbol, reason: "missing_filters" });
      continue;
    }
    const tickSize = str(price.tickSize);
    const stepSize = str(lot.stepSize);
    if (!isPositive(tickSize) || !isPositive(stepSize)) {
      skipped.push({ symbol: s.symbol, reason: "zero_step" });
      continue;
    }

    filters[s.symbol] = {
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      status: s.status ?? "UNKNOWN",
      tickSize,
      minPrice: str(price.minPrice),
      maxPrice: price.maxPrice !== undefined && str(price.maxPrice) !== "0" ? str(price.maxPrice) : null,
      stepSize,
      minQty: str(lot.minQty),
      maxQty: lot.maxQty !== undefined && str(lot.maxQty) !== "0" ? str(lot.maxQty) : null,
      marketStepSize: marketLot && isPositive(str(marketLot.stepSize)) ? str(marketLot.stepSize) : null,
      marketMinQty: marketLot ? str(marketLot.minQty) : null,
      marketMaxQty: marketLot && str(marketLot.maxQty) !== "0" ? str(marketLot.maxQty) : null,
      minNotional: str(notional.minNotional ?? notional.notional),
      applyMinToMarket:
        notional.applyMinToMarket === true || notional.applyToMarket === true || notional.filterType === "MIN_NOTIONAL",
      fetchedAt: nowMs,
    };
  }
  return { filters, skipped };
}

/** Elavult-e a szűrőkészlet? Ismeretlen szabályokkal nem küldünk ordert. */
export function isStale(filters: SymbolFilters, nowMs: number, maxAgeMs = DEFAULT_FILTER_MAX_AGE_MS): boolean {
  return nowMs - filters.fetchedAt > maxAgeMs;
}

/** Az árat LEFELÉ kerekítjük a tickSize-ra. Nincs univerzális toFixed. */
export function roundPrice(price: Dec, filters: SymbolFilters): Dec {
  return floorToStep(price, filters.tickSize);
}

/**
 * A mennyiséget LEFELÉ kerekítjük a stepSize-ra. Market ordernél a MARKET_LOT_SIZE
 * lépésköze az irányadó, ha van.
 */
export function roundQty(qty: Dec, filters: SymbolFilters, orderType: "MARKET" | "LIMIT" = "MARKET"): Dec {
  const step = orderType === "MARKET" && filters.marketStepSize ? filters.marketStepSize : filters.stepSize;
  return floorToStep(qty, step);
}

/** A kerekített mennyiség notional értéke az adott áron. */
export function notionalOf(qty: Dec, price: Dec): Dec {
  return mul(qty, price);
}

export interface OrderCheckInput {
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  /** A KEREKÍTETT mennyiség. */
  qty: Dec;
  /** A KEREKÍTETT ár (limitnél a limitár, marketnél a becsült teljesülési ár). */
  price: Dec;
  nowMs: number;
  maxFilterAgeMs?: number;
}

/**
 * Egy order ellenőrzése a tőzsdei szabályokkal. A hívó ELŐSZÖR kerekít, azután ellenőriz —
 * a kerekítés UTÁNI notional a döntő, nem a kerekítés előtti.
 */
export function checkOrder(input: OrderCheckInput, filters: SymbolFilters | undefined): RuleCheck {
  if (!filters) {
    return { ok: false, reason: "unknown_symbol", message: `Nincs szűrőkészlet: ${input.symbol}` };
  }
  if (filters.status !== "TRADING") {
    return { ok: false, reason: "not_trading", message: `A ${filters.symbol} státusza ${filters.status}` };
  }
  if (isStale(filters, input.nowMs, input.maxFilterAgeMs)) {
    return {
      ok: false,
      reason: "stale_filters",
      message: `A ${filters.symbol} szűrőkészlete elavult (${input.nowMs - filters.fetchedAt} ms) — nem küldünk ordert ismeretlen szabályokkal.`,
    };
  }
  if (!isPositive(input.qty)) {
    return { ok: false, reason: "zero_after_rounding", message: "A kerekítés után nem maradt mennyiség." };
  }

  const minQty = input.orderType === "MARKET" && filters.marketMinQty ? filters.marketMinQty : filters.minQty;
  const maxQty = input.orderType === "MARKET" && filters.marketMaxQty ? filters.marketMaxQty : filters.maxQty;
  if (isPositive(minQty) && lt(input.qty, minQty)) {
    return { ok: false, reason: "below_min_qty", message: `${input.qty} < minQty ${minQty}` };
  }
  if (maxQty && gt(input.qty, maxQty)) {
    return { ok: false, reason: "above_max_qty", message: `${input.qty} > maxQty ${maxQty}` };
  }
  if (isPositive(filters.minPrice) && lt(input.price, filters.minPrice)) {
    return { ok: false, reason: "price_out_of_range", message: `${input.price} < minPrice ${filters.minPrice}` };
  }
  if (filters.maxPrice && gt(input.price, filters.maxPrice)) {
    return { ok: false, reason: "price_out_of_range", message: `${input.price} > maxPrice ${filters.maxPrice}` };
  }

  const appliesNotional = input.orderType === "LIMIT" || filters.applyMinToMarket;
  if (appliesNotional && isPositive(filters.minNotional)) {
    const notional = notionalOf(input.qty, input.price);
    if (lt(notional, filters.minNotional)) {
      return {
        ok: false,
        reason: "below_min_notional",
        message: `A kerekítés utáni kötésérték ${notional} < ${filters.minNotional} (${filters.symbol})`,
      };
    }
  }
  return { ok: true };
}

export interface SizedOrder {
  qty: Dec;
  price: Dec;
  /** A ténylegesen elköltendő quote-összeg a kerekítés után. */
  notional: Dec;
  check: RuleCheck;
}

/**
 * Egy BUY méretezése quote-keretből: mennyiség = keret / ár, LEFELÉ kerekítve, majd
 * ellenőrizve. A visszaadott `notional` a kerekítés UTÁNI valós költés.
 */
export function sizeBuy(
  quoteBudget: Dec,
  price: Dec,
  filters: SymbolFilters | undefined,
  nowMs: number,
  orderType: "MARKET" | "LIMIT" = "MARKET",
): SizedOrder {
  if (!filters || !isPositive(price)) {
    return {
      qty: ZERO,
      price,
      notional: ZERO,
      check: { ok: false, reason: "unknown_symbol", message: "Hiányzó szűrő vagy ár." },
    };
  }
  const roundedPrice = roundPrice(price, filters);
  const rawQty = div(quoteBudget, isPositive(roundedPrice) ? roundedPrice : price);
  const qty = roundQty(rawQty, filters, orderType);
  const notional = notionalOf(qty, isPositive(roundedPrice) ? roundedPrice : price);
  return {
    qty,
    price: roundedPrice,
    notional,
    check: checkOrder({ symbol: filters.symbol, side: "BUY", orderType, qty, price: roundedPrice, nowMs }, filters),
  };
}

/** Egy SELL méretezése birtokolt mennyiségből: lefelé kerekítés, majd ellenőrzés. */
export function sizeSell(
  baseQty: Dec,
  price: Dec,
  filters: SymbolFilters | undefined,
  nowMs: number,
  orderType: "MARKET" | "LIMIT" = "MARKET",
): SizedOrder {
  if (!filters || !isPositive(price)) {
    return {
      qty: ZERO,
      price,
      notional: ZERO,
      check: { ok: false, reason: "unknown_symbol", message: "Hiányzó szűrő vagy ár." },
    };
  }
  const roundedPrice = roundPrice(price, filters);
  const qty = roundQty(baseQty, filters, orderType);
  return {
    qty,
    price: roundedPrice,
    notional: notionalOf(qty, isPositive(roundedPrice) ? roundedPrice : price),
    check: checkOrder({ symbol: filters.symbol, side: "SELL", orderType, qty, price: roundedPrice, nowMs }, filters),
  };
}

/**
 * A védőorder (STOP_LOSS_LIMIT) árainak kerekítése. A stop-ár és a limitár is tickSize-ra
 * kerül; a limitár a stop ALATT marad, hogy eladáskor teljesüljön.
 */
export function protectionPrices(
  stopPrice: Dec,
  filters: SymbolFilters,
  limitOffsetPct: Dec = "0.001",
): { stop: Dec; limit: Dec } {
  const stop = roundPrice(stopPrice, filters);
  const limitRaw = mul(stop, sub("1", limitOffsetPct));
  let limit = roundPrice(limitRaw, filters);
  // Ha a kerekítés egybeejtené a kettőt, egy tickkel lejjebb visszük a limitet.
  if (gte(limit, stop)) limit = floorToStep(sub(stop, filters.tickSize), filters.tickSize);
  return { stop, limit };
}

/** Az elérhető szimbólum-nevek (a kosár coinjaiból tőzsdei pár). */
export function pairFor(symbol: string, quote = "USDT"): string {
  return `${symbol}${quote}`;
}

// ── Hálózati lekérés ────────────────────────────────────────────────────────

const BINANCE_BASE = "https://api.binance.com";

export interface FetchFiltersResult {
  filters: Record<string, SymbolFilters>;
  error: { code: "http_error" | "network" | "bad_payload"; message: string } | null;
  skipped: { symbol: string; reason: string }[];
}

/**
 * Az aktuális szűrőkészlet lekérése. Hiba esetén ÜRES készlet és strukturált hiba —
 * a hívó ilyenkor NEM küld ordert (ismeretlen szabályok).
 */
export async function fetchSymbolFilters(
  pairs: string[],
  opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<FetchFiltersResult> {
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const query = pairs.map((p) => `"${p}"`).join(",");
  const url = `${BINANCE_BASE}/api/v3/exchangeInfo?symbols=[${encodeURIComponent(query)}]`;
  try {
    const res = await doFetch(url);
    if (!res.ok) {
      return { filters: {}, skipped: [], error: { code: "http_error", message: `Binance HTTP ${res.status}` } };
    }
    const body = await res.json();
    const parsed = parseExchangeInfo(body, now());
    if (Object.keys(parsed.filters).length === 0) {
      return { filters: {}, skipped: parsed.skipped, error: { code: "bad_payload", message: "Nem értelmezhető exchangeInfo." } };
    }
    return { filters: parsed.filters, skipped: parsed.skipped, error: null };
  } catch (e) {
    return { filters: {}, skipped: [], error: { code: "network", message: String(e) } };
  }
}

export { add, lte, isPositive, round };

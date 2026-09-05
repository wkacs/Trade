/**
 * Végrehajtási ár KÜLÖN adatúton (T14).
 *
 * Az audit B. szakasza szerint a motor a profit-ciklus előtt MEGVÁRTA az ÖSSZES collector
 * befejezését — köztük az RSS-t és a sentimentet. Egy lassú hírforrás így késleltette a
 * stop-loss végrehajtását. A kilépésnek friss ÁRRA kell várnia, nem hírre és nem LLM-re.
 *
 * Emellett a régi kód a gyertya-close-t használta „aktuális árnak", és nem volt fogalma
 * az adat KORÁRÓL. Itt minden quote hordozza a beérkezés idejét, és a frissesség explicit:
 * a mérnöki induló cél legfeljebb 10 másodperces quote; ennél régebbin nem megy ki új
 * market order, hanem MÉRHETŐ állapot és riasztás keletkezik.
 */
import { type Dec, dec, div, add, sub, mul, isPositive, gt } from "@/lib/portfolio/money";

export type QuoteSource = "binance-book" | "binance-price" | "fallback";

export interface Quote {
  symbol: string;
  bid: Dec;
  ask: Dec;
  /** (bid + ask) / 2 — a jelzésekhez; a végrehajtás a saját oldalát használja. */
  mid: Dec;
  /** A tőzsde által jelentett idő, ha van. A bookTicker nem ad ilyet → null. */
  exchangeTime: number | null;
  /** Mikor érkezett hozzánk (a frissesség ebből mérhető). */
  receivedAt: number;
  source: QuoteSource;
}

export interface QuoteError {
  symbol: string;
  code: "timeout" | "http_error" | "network" | "bad_payload" | "missing";
  message: string;
}

export interface QuoteSnapshot {
  quotes: Record<string, Quote>;
  errors: QuoteError[];
  /** A leggyorsabban elavuló quote kora — a tick egészségének mérőszáma. */
  maxAgeMs: number;
  /** Igaz, ha BÁRMELYIK kért symbolra hiányzik vagy elavult a quote. */
  degraded: boolean;
}

/** Mérnöki induló cél: ennél régebbi quote-ra nem megy ki új market order. */
export const DEFAULT_QUOTE_MAX_AGE_MS = 10_000;

/** A quote lekérésének időkorlátja — a végrehajtási út nem várhat korlátlanul. */
export const DEFAULT_QUOTE_TIMEOUT_MS = 3_000;

export function quoteAgeMs(quote: Quote, nowMs: number): number {
  return Math.max(0, nowMs - quote.receivedAt);
}

export function isFresh(quote: Quote, nowMs: number, maxAgeMs = DEFAULT_QUOTE_MAX_AGE_MS): boolean {
  return quoteAgeMs(quote, nowMs) <= maxAgeMs;
}

/** A végrehajtási oldal ára: BUY az ask-on, SELL a bid-en. */
export function executionPrice(quote: Quote, side: "BUY" | "SELL"): Dec {
  return side === "BUY" ? quote.ask : quote.bid;
}

/** A spread bázispontban — a költségriportnak és a fill-modellnek. */
export function spreadBps(quote: Quote): number {
  if (!isPositive(quote.mid)) return 0;
  return Number(mul(div(sub(quote.ask, quote.bid), quote.mid), "10000"));
}

/** Tiszta összeállító: nyers bid/ask → Quote. Érvénytelen bemenetre null. */
export function makeQuote(
  symbol: string,
  bid: string | number,
  ask: string | number,
  receivedAt: number,
  source: QuoteSource,
  exchangeTime: number | null = null,
): Quote | null {
  let b: Dec;
  let a: Dec;
  try {
    b = dec(typeof bid === "number" ? bid : bid);
    a = dec(typeof ask === "number" ? ask : ask);
  } catch {
    return null;
  }
  if (!isPositive(b) || !isPositive(a) || gt(b, a)) return null;
  return { symbol, bid: b, ask: a, mid: div(add(b, a), "2"), exchangeTime, receivedAt, source };
}

const BINANCE_BASE = "https://api.binance.com";

export interface FetchQuotesOptions {
  now?: () => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  quotePair?: string;
  maxAgeMs?: number;
}

/**
 * Friss bid/ask lekérése a Binance bookTicker végpontról. IDŐKORLÁTOS: a hívás a
 * megadott idő után megszakad, és a hiányzó symbol STRUKTURÁLT hibaként látszik.
 *
 * Ez az út NEM függ a hírgyűjtőktől, a sentimenttől és az LLM-től.
 */
export async function fetchQuotes(symbols: string[], opts: FetchQuotesOptions = {}): Promise<QuoteSnapshot> {
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUOTE_TIMEOUT_MS;
  const pair = opts.quotePair ?? "USDT";
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_QUOTE_MAX_AGE_MS;

  const quotes: Record<string, Quote> = {};
  const errors: QuoteError[] = [];

  const pairs = symbols.map((s) => `"${s}${pair}"`).join(",");
  const url = `${BINANCE_BASE}/api/v3/ticker/bookTicker?symbols=[${encodeURIComponent(pairs)}]`;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(url, controller ? { signal: controller.signal } : undefined);
    if (!res.ok) {
      for (const s of symbols) errors.push({ symbol: s, code: "http_error", message: `Binance HTTP ${res.status}` });
    } else {
      const body = (await res.json()) as { symbol: string; bidPrice: string; askPrice: string }[];
      const receivedAt = now();
      if (!Array.isArray(body)) {
        for (const s of symbols) errors.push({ symbol: s, code: "bad_payload", message: "Váratlan válaszformátum" });
      } else {
        for (const row of body) {
          const symbol = row.symbol?.replace(new RegExp(`${pair}$`), "");
          if (!symbol) continue;
          const q = makeQuote(symbol, row.bidPrice, row.askPrice, receivedAt, "binance-book");
          if (q) quotes[symbol] = q;
          else errors.push({ symbol, code: "bad_payload", message: `Érvénytelen bid/ask: ${row.bidPrice}/${row.askPrice}` });
        }
      }
    }
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
    for (const s of symbols) {
      errors.push({
        symbol: s,
        code: aborted ? "timeout" : "network",
        message: aborted ? `A quote-lekérés ${timeoutMs} ms alatt nem érkezett meg` : String(e),
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  for (const s of symbols) {
    if (!quotes[s] && !errors.some((e) => e.symbol === s)) {
      errors.push({ symbol: s, code: "missing", message: `Nem érkezett quote: ${s}` });
    }
  }

  const nowMs = now();
  const ages = Object.values(quotes).map((q) => quoteAgeMs(q, nowMs));
  const maxAge = ages.length > 0 ? Math.max(...ages) : Number.POSITIVE_INFINITY;
  return {
    quotes,
    errors,
    maxAgeMs: ages.length > 0 ? maxAge : 0,
    degraded: errors.length > 0 || maxAge > maxAgeMs,
  };
}

/**
 * A végrehajtás előtti UTOLSÓ ellenőrzés: van-e friss quote ehhez a szimbólumhoz?
 * Elavult ár esetén NEM megy ki market order — a hívó strukturált okot kap.
 */
export function checkExecutionQuote(
  snapshot: QuoteSnapshot,
  symbol: string,
  nowMs: number,
  maxAgeMs = DEFAULT_QUOTE_MAX_AGE_MS,
): { ok: true; quote: Quote } | { ok: false; reason: "missing" | "stale"; ageMs: number | null } {
  const quote = snapshot.quotes[symbol];
  if (!quote) return { ok: false, reason: "missing", ageMs: null };
  const age = quoteAgeMs(quote, nowMs);
  if (age > maxAgeMs) return { ok: false, reason: "stale", ageMs: age };
  return { ok: true, quote };
}

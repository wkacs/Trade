import { describe, it, expect, vi } from "vitest";
import {
  fetchQuotes,
  makeQuote,
  quoteAgeMs,
  isFresh,
  executionPrice,
  spreadBps,
  checkExecutionQuote,
  DEFAULT_QUOTE_MAX_AGE_MS,
  type QuoteSnapshot,
} from "@/lib/market/quotes";

const NOW = 1_700_000_000_000;

const okResponse = (rows: { symbol: string; bidPrice: string; askPrice: string }[]) =>
  ({ ok: true, status: 200, json: async () => rows }) as unknown as Response;

describe("quotes — friss bid/ask külön adatúton", () => {
  it("bid/ask és mid a Binance bookTickerből", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { symbol: "BTCUSDT", bidPrice: "59990", askPrice: "60010" },
        { symbol: "ETHUSDT", bidPrice: "2999", askPrice: "3001" },
      ]),
    ) as unknown as typeof fetch;

    const snap = await fetchQuotes(["BTC", "ETH"], { now: () => NOW, fetchImpl });
    expect(snap.quotes.BTC.bid).toBe("59990");
    expect(snap.quotes.BTC.ask).toBe("60010");
    expect(snap.quotes.BTC.mid).toBe("60000");
    expect(snap.degraded).toBe(false);
  });

  it("a hiányzó symbol STRUKTURÁLT hiba, nem néma kihagyás", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([{ symbol: "BTCUSDT", bidPrice: "59990", askPrice: "60010" }]),
    ) as unknown as typeof fetch;

    const snap = await fetchQuotes(["BTC", "SOL"], { now: () => NOW, fetchImpl });
    expect(snap.quotes.SOL).toBeUndefined();
    expect(snap.errors).toContainEqual({ symbol: "SOL", code: "missing", message: "Nem érkezett quote: SOL" });
    expect(snap.degraded).toBe(true);
  });

  it("HTTP hiba esetén minden symbolra hiba keletkezik", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch;
    const snap = await fetchQuotes(["BTC"], { now: () => NOW, fetchImpl });
    expect(snap.errors[0].code).toBe("http_error");
    expect(snap.degraded).toBe(true);
  });

  it("időtúllépés esetén NEM várunk korlátlanul", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const snap = await fetchQuotes(["BTC"], { now: () => NOW, fetchImpl, timeoutMs: 20 });
    expect(snap.errors[0].code).toBe("timeout");
    expect(snap.quotes.BTC).toBeUndefined();
  });

  it("érvénytelen bid/ask elutasításra kerül (bid > ask sem fogadható el)", async () => {
    expect(makeQuote("BTC", "60010", "59990", NOW, "binance-book")).toBeNull();
    expect(makeQuote("BTC", "0", "60000", NOW, "binance-book")).toBeNull();
    expect(makeQuote("BTC", "abc", "60000", NOW, "binance-book")).toBeNull();
  });
});

describe("quotes — frissesség és végrehajtási oldal", () => {
  const quote = makeQuote("BTC", "59990", "60010", NOW, "binance-book")!;

  it("a kor a beérkezés idejéből számol", () => {
    expect(quoteAgeMs(quote, NOW)).toBe(0);
    expect(quoteAgeMs(quote, NOW + 5000)).toBe(5000);
    // A múltba mutató óra nem ad negatív kort.
    expect(quoteAgeMs(quote, NOW - 1000)).toBe(0);
  });

  it("a 10 másodperces küszöb a mérnöki induló cél", () => {
    expect(DEFAULT_QUOTE_MAX_AGE_MS).toBe(10_000);
    expect(isFresh(quote, NOW + 9_999)).toBe(true);
    expect(isFresh(quote, NOW + 10_001)).toBe(false);
  });

  it("BUY az ask-on, SELL a bid-en hajtódik végre", () => {
    expect(executionPrice(quote, "BUY")).toBe("60010");
    expect(executionPrice(quote, "SELL")).toBe("59990");
  });

  it("a spread bázispontban mérhető", () => {
    expect(spreadBps(quote)).toBeCloseTo((20 / 60000) * 10000, 6);
  });

  it("10 s feletti quote NEM válik friss orderré", () => {
    const snap: QuoteSnapshot = { quotes: { BTC: quote }, errors: [], maxAgeMs: 0, degraded: false };
    const ok = checkExecutionQuote(snap, "BTC", NOW + 1000);
    expect(ok.ok).toBe(true);

    const stale = checkExecutionQuote(snap, "BTC", NOW + 11_000);
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.reason).toBe("stale");
    expect(!stale.ok && stale.ageMs).toBe(11_000);
  });

  it("hiányzó quote esetén nincs végrehajtás", () => {
    const snap: QuoteSnapshot = { quotes: {}, errors: [], maxAgeMs: 0, degraded: false };
    const r = checkExecutionQuote(snap, "BTC", NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("missing");
  });
});

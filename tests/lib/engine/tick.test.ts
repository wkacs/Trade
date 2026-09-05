import { describe, it, expect, vi, beforeEach } from "vitest";

// Minden külső függőséget mockolunk, hogy a ciklus determinisztikusan tesztelhető legyen
vi.mock("@/lib/collectors/base", () => ({
  collectAll: vi.fn(),
  collectAllWithOutcomes: vi.fn(),
}));
vi.mock("@/lib/collectors/coingecko", () => ({ CoinGeckoCollector: vi.fn() }));
vi.mock("@/lib/collectors/cryptopanic", () => ({ CryptoPanicCollector: vi.fn() }));
vi.mock("@/lib/collectors/whalealert", () => ({ WhaleAlertCollector: vi.fn() }));
vi.mock("@/lib/collectors/rss", () => ({ RSSCollector: vi.fn() }));
vi.mock("@/lib/collectors/binance", () => ({
  BinanceOHLCCollector: vi.fn(),
  // A jelek valódi gyertyákból számolnak; a unit-tesztben nincs OHLCV, ezért üres.
  candlesFromDataPoints: vi.fn(() => []),
}));
vi.mock("@/lib/collectors/feargreed", () => ({ FearGreedCollector: vi.fn() }));
vi.mock("@/lib/collectors/reddit", () => ({ RedditCollector: vi.fn() }));
vi.mock("@/lib/llm/phase1-filter", () => ({ shouldDecide: vi.fn() }));
vi.mock("@/lib/llm/phase2-decide", () => ({ decide: vi.fn() }));
vi.mock("@/lib/market/quotes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/market/quotes")>();
  return { ...actual, fetchQuotes: vi.fn(async () => mockQuoteSnapshot) };
});
vi.mock("@/lib/ml/predictor", () => ({
  predict: vi.fn(),
  predictWithStatus: vi.fn(() => ({
    signals: [],
    status: { usable: true, featureVersion: "test", trainedAtMs: 0 },
  })),
}));
// Portfólió-réteg mock. FONTOS (T06): a régi 10 000 USD-s demo fallback MEGSZŰNT —
// hiteles portfólió-állapot nélkül a tick nem köt. Ezért itt egy explicit teszt-portfóliót
// adunk vissza; a "nincs DB" esetre külön teszt van lent.
vi.mock("@/lib/portfolio/accounting", () => ({
  loadPortfolioState: vi.fn(),
  applyTrade: vi.fn().mockResolvedValue({ positionId: null }),
  setStopPrice: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/portfolio/evaluate", () => ({
  getPerformanceSummary: vi.fn().mockResolvedValue({ evaluated: 0, actionable: 0, hitRate: null, avgHypotheticalPnlPct: 0 }),
  evaluatePending: vi.fn().mockResolvedValue({ evaluated: 0 }),
}));
// A tartós végrehajtási állapot (T09) mockolása: a tick a v2 ledgert az order-store-ból
// olvassa és oda ír. DB nélküli unit-tesztben ezt injektáljuk.
vi.mock("@/lib/execution/order-store", () => ({
  hasLedgerState: vi.fn(async () => true),
  loadLedgerState: vi.fn(async () => mockLedgerFixture),
  loadReservations: vi.fn(async () => ({ bySymbol: {}, total: "0" })),
  reserveBudget: vi.fn(async () => true),
  releaseReservation: vi.fn(async () => undefined),
  recordIntent: vi.fn(async () => undefined),
  persistFill: vi.fn(async () => ({ applied: true })),
  persistStopPrice: vi.fn(async () => true),
  seedLedger: vi.fn(async () => undefined),
  expireStaleReservations: vi.fn(async () => 0),
}));

import { collectAllWithOutcomes } from "@/lib/collectors/base";
import { shouldDecide } from "@/lib/llm/phase1-filter";
import { decide } from "@/lib/llm/phase2-decide";
import { predict } from "@/lib/ml/predictor";
import { loadPortfolioState } from "@/lib/portfolio/accounting";
import { runTick } from "@/lib/engine/tick";
import { persistFill } from "@/lib/execution/order-store";
import type { DataPoint } from "@/lib/types";

/** A phase-2 döntés mockolása az ÚJ (T16) alakban: {decision, usage, promptChars}. */
function mockDecision(d: { action: "BUY" | "SELL" | "HOLD"; symbol?: string; amountPct?: number; confidence: number; reasoning: string }) {
  (decide as any).mockResolvedValue({
    decision: {
      schemaVersion: 2,
      action: d.action,
      symbol: d.symbol ?? null,
      equityFraction: d.action === "BUY" ? (d.amountPct ?? 0) : 0,
      positionFraction: d.action === "SELL" ? (d.amountPct ?? 0) : 0,
      confidence: d.confidence,
      reasoning: d.reasoning,
      adjustments: [],
    },
    usage: {
      model: "glm-5.2",
      promptVersion: "p2-test",
      latencyMs: 10,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      failed: false,
    },
    promptChars: 100,
  });
}

/** A quote-pillanatkép, amit a mockolt `fetchQuotes` visszaad (T14). */
let mockQuoteSnapshot: any = { quotes: {}, errors: [], maxAgeMs: 0, degraded: false };

/**
 * A collector-eredmény ÉS a végrehajtási quote-ok beállítása egy lépésben.
 * A quote a price-eseményekből származik (bid = ask = mid = ár), hogy a fill-ár
 * a régi tesztek elvárásaival egyezzen.
 */
function mockMarket(points: any[], nowMs = Date.now()) {
  (collectAllWithOutcomes as any).mockResolvedValue({
    points,
    outcomes: [{ name: "mock", ok: true, points: points.length, durationMs: 1 }],
    degraded: false,
  });
  const quotes: Record<string, any> = {};
  for (const p of points) {
    if (p.kind === "price" && p.price) {
      const v = String(p.price.usd);
      quotes[p.symbol] = {
        symbol: p.symbol,
        bid: v,
        ask: v,
        mid: v,
        exchangeTime: null,
        receivedAt: nowMs,
        source: "binance-book",
      };
    }
  }
  mockQuoteSnapshot = { quotes, errors: [], maxAgeMs: 0, degraded: false };
}

/** A v2 ledger pillanatképe, amit a mockolt order-store visszaad. */
let mockLedgerFixture: any = { portfolioId: "pf-test", mode: "paper", cash: { USDT: "0" }, positions: {}, appliedFillKeys: [], realizedPnlQuote: "0" };

/** A mockolt ledger beállítása a v1-stílusú teszt-állapotból. */
function setLedgerFixture(cashUsd: number, positions: { symbol: string; qty: number; entryPrice: number; stopPrice: number }[]) {
  mockLedgerFixture = {
    portfolioId: "pf-test",
    mode: "paper",
    cash: { USDT: String(cashUsd) },
    positions: Object.fromEntries(
      positions.map((p) => [
        p.symbol,
        {
          symbol: p.symbol,
          qty: String(p.qty),
          costBasisQuote: String(p.qty * p.entryPrice),
          stopPrice: p.stopPrice > 0 ? String(p.stopPrice) : null,
        },
      ]),
    ),
    appliedFillKeys: [],
    realizedPnlQuote: "0",
  };
}

const priceEvent = (symbol: string, usd: number): DataPoint => ({
  source: "coingecko",
  symbol,
  timestamp: Date.now(),
  kind: "price",
  price: { usd, volume24h: 1_000_000, change24hPct: 0 },
});

describe("runTick — teljes döntési ciklus", () => {
  beforeEach(() => {
    vi.stubEnv("TRADING_MODE", "paper");
    mockMarket([priceEvent("BTC", 60000)]);
    (predict as any).mockResolvedValue([]);
    setLedgerFixture(10000, []);
    (loadPortfolioState as any).mockResolvedValue({
      portfolioId: "pf-test",
      cashUsd: 10000,
      initialCapitalUsd: 10000,
      positions: [],
      totalEquity: () => 10000,
      dayPnlPct: 0,
    });
  });

  it("phase-1 'ne dönts' → HOLD, nincs tranzakció", async () => {
    (shouldDecide as any).mockResolvedValue({
      shouldDecide: false,
      summary: "csendes óra",
      notableEvents: [],
    });
    const result = await runTick({ tickId: "2026-06-25-10", paperMode: true });
    expect(result.decision.action).toBe("HOLD");
    expect(result.trade).toBeNull();
    // phase-2 nem is hívdik meg, ha phase-1 nemet mond
    expect(decide).not.toHaveBeenCalled();
  });

  it("phase-1 'dönts' + phase-2 BUY → tranzakció történik", async () => {
    (shouldDecide as any).mockResolvedValue({
      shouldDecide: true,
      summary: "ETF hír",
      notableEvents: [{ symbol: "BTC", reason: "inflow" }],
    });
    mockDecision({
      action: "BUY",
      symbol: "BTC",
      amountPct: 0.15,
      confidence: 0.7,
      reasoning: "ETF inflow + whale gyűjtés → bullish.",
    });
    const result = await runTick({ tickId: "2026-06-25-11", paperMode: true });
    expect(result.decision.action).toBe("BUY");
    expect(result.decision.symbol).toBe("BTC");
    expect(result.trade).toBeTruthy();
    expect(result.trade?.mode).toBe("paper");
    expect(result.trade?.symbol).toBe("BTC");
    expect(result.trade?.side).toBe("BUY");
    const deltas = (persistFill as any).mock.calls.at(-1)[2];
    expect(Number(deltas.position.stopPrice)).toBeGreaterThan(0);
    expect(Number(deltas.position.stopPrice)).toBeLessThan(result.trade!.price);
  });

  it("reconciliation vagy protection tiltás mellett az új BUY nem jut el a brokerig", async () => {
    (persistFill as any).mockClear();
    (shouldDecide as any).mockResolvedValue({ shouldDecide: true, summary: "x", notableEvents: [] });
    mockDecision({ action: "BUY", symbol: "BTC", amountPct: 0.1, confidence: 0.9, reasoning: "bullish" });
    const result = await runTick({ tickId: "2026-06-25-gated", paperMode: true, allowNewBuys: false });
    expect(result.rawAction).toBe("BUY");
    expect(result.trade).toBeNull();
    expect(persistFill).not.toHaveBeenCalled();
  });

  it("phase-2 HOLD esetén nincs tranzakció", async () => {
    (shouldDecide as any).mockResolvedValue({
      shouldDecide: true,
      summary: "vegyes",
      notableEvents: [],
    });
    mockDecision({
      action: "HOLD",
      amountPct: 0,
      confidence: 0.4,
      reasoning: "semmi egyértelmű",
    });
    const result = await runTick({ tickId: "2026-06-25-12", paperMode: true });
    expect(result.decision.action).toBe("HOLD");
    expect(result.trade).toBeNull();
  });

  it("Risk Manager módosíthatja a döntést", async () => {
    (shouldDecide as any).mockResolvedValue({
      shouldDecide: true,
      summary: "x",
      notableEvents: [],
    });
    // a GLM túl merészet javasol (50%) — a Risk Manager visszavágja 20%-ra
    mockDecision({
      action: "BUY",
      symbol: "BTC",
      amountPct: 0.5,
      confidence: 0.9,
      reasoning: "nagyon bullish",
    });
    const result = await runTick({ tickId: "2026-06-25-13", paperMode: true });
    expect(result.decision.amountPct).toBe(0.2);
    expect(result.decision.overridden).toBe(true);
  });

  it("hiteles portfólió-állapot NÉLKÜL nincs kötés (nincs 10 000 USD fallback)", async () => {
    (loadPortfolioState as any).mockResolvedValue(null);
    (shouldDecide as any).mockResolvedValue({ shouldDecide: true, summary: "x", notableEvents: [] });
    mockDecision({
      action: "BUY",
      symbol: "BTC",
      amountPct: 0.1,
      confidence: 0.9,
      reasoning: "bullish",
    });
    const result = await runTick({ tickId: "2026-06-25-14", paperMode: true });
    expect(result.tradingEnabled).toBe(false);
    expect(result.trade).toBeNull();
    // Az AI eredeti szándéka naplózódik (rawAction), de a kapu HOLD-ra váltja:
    // nulla equity mellett nincs szabad keret, és order sem megy ki.
    expect(result.rawAction).toBe("BUY");
    expect(result.decision.action).toBe("HOLD");
  });

  it("momentum-wiring (default OFF): a tick lefut, process megvan, nincs momentum cycle-action", async () => {
    (shouldDecide as any).mockResolvedValue({ shouldDecide: false, summary: "csendes", notableEvents: [] });
    const result = await runTick({ tickId: "2026-06-28-15", paperMode: true });
    expect(result.process).toBeDefined();
    expect(result.cycleActions.every((a) => a.kind !== "momentum")).toBe(true);
  });
});

describe("runTick — végrehajtási ár és adatfrissesség (T14)", () => {
  beforeEach(() => {
    vi.stubEnv("TRADING_MODE", "paper");
    (predict as any).mockResolvedValue([]);
    setLedgerFixture(10000, []);
    (loadPortfolioState as any).mockResolvedValue({
      portfolioId: "pf-test",
      cashUsd: 10000,
      initialCapitalUsd: 10000,
      positions: [],
      totalEquity: () => 10000,
      dayPnlPct: 0,
    });
    (shouldDecide as any).mockResolvedValue({ shouldDecide: true, summary: "x", notableEvents: [] });
    mockDecision({
      action: "BUY",
      symbol: "BTC",
      amountPct: 0.1,
      confidence: 0.9,
      reasoning: "bullish",
    });
  });

  it("ELAVULT quote mellett NEM megy ki order, és ez mérhető állapot", async () => {
    mockMarket([priceEvent("BTC", 60000)]);
    // A quote 30 másodperces — a 10 s-os küszöb felett.
    mockQuoteSnapshot = {
      quotes: {
        BTC: {
          symbol: "BTC",
          bid: "60000",
          ask: "60000",
          mid: "60000",
          exchangeTime: null,
          receivedAt: Date.now() - 30_000,
          source: "binance-book",
        },
      },
      errors: [],
      maxAgeMs: 30_000,
      degraded: true,
    };

    const result = await runTick({ tickId: "2026-06-25-15", paperMode: true });
    expect(result.trade).toBeNull();
    expect(result.quotes.staleSkips.some((s) => s.symbol === "BTC" && s.reason === "stale")).toBe(true);
  });

  it("hiányzó quote mellett sincs order", async () => {
    mockMarket([priceEvent("BTC", 60000)]);
    mockQuoteSnapshot = { quotes: {}, errors: [{ symbol: "BTC", code: "timeout" }], maxAgeMs: 0, degraded: true };

    const result = await runTick({ tickId: "2026-06-25-16", paperMode: true });
    expect(result.trade).toBeNull();
    expect(result.quotes.degraded).toBe(true);
  });

  it("friss quote mellett a végrehajtás megtörténik, és a quote-állapot riportálódik", async () => {
    mockMarket([priceEvent("BTC", 60000)]);
    const result = await runTick({ tickId: "2026-06-25-17", paperMode: true });
    expect(result.trade).toBeTruthy();
    expect(result.quotes.degraded).toBe(false);
    expect(result.quotes.staleSkips).toEqual([]);
    expect(result.collectors.length).toBeGreaterThan(0);
  });
});

describe("runTick — AI-intent és valós portfóliókontextus (T16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TRADING_MODE", "paper");
    (predict as any).mockResolvedValue([]);
    mockMarket([priceEvent("BTC", 60000)]);
    (shouldDecide as any).mockResolvedValue({ shouldDecide: true, summary: "x", notableEvents: [] });
  });

  it("az AI VALÓS belépési árat és szabad keretet kap (nem nullát)", async () => {
    setLedgerFixture(40, [{ symbol: "BTC", qty: 0.001, entryPrice: 60000, stopPrice: 57000 }]);
    (loadPortfolioState as any).mockResolvedValue({
      portfolioId: "pf-test",
      cashUsd: 40,
      initialCapitalUsd: 100,
      positions: [{ id: "p1", symbol: "BTC", qty: 0.001, entryPrice: 60000, stopPrice: 57000, valueUsd: 60 }],
      totalEquity: () => 100,
      dayPnlPct: 0,
    });
    mockDecision({ action: "HOLD", confidence: 0.3, reasoning: "csend" });

    await runTick({ tickId: "2026-06-25-20", paperMode: true });

    const call = (decide as any).mock.calls[0][0];
    expect(call.portfolio.positions[0].entryPrice).toBe(60000);
    expect(call.portfolio.positions[0].valueUsd).toBe(60);
    expect(call.portfolio.equityUsd).toBe(100);
    // 20% pozíciólimit 100 equityn = 20; a meglévő 60 → nincs szabad keret BTC-re.
    expect(call.portfolio.freeBuyBudgetUsd.BTC).toBe(0);
    expect(call.allowedSymbols).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("SELL cash=0 mellett is végrehajtódik (a méret a birtokolt mennyiségből)", async () => {
    setLedgerFixture(0, [{ symbol: "BTC", qty: 0.001, entryPrice: 60000, stopPrice: 0 }]);
    (loadPortfolioState as any).mockResolvedValue({
      portfolioId: "pf-test",
      cashUsd: 0,
      initialCapitalUsd: 100,
      positions: [{ id: "p1", symbol: "BTC", qty: 0.001, entryPrice: 60000, stopPrice: 0, valueUsd: 60 }],
      totalEquity: () => 60,
      dayPnlPct: 0,
    });
    mockDecision({ action: "SELL", symbol: "BTC", amountPct: 1, confidence: 0.8, reasoning: "kiszállás" });

    const result = await runTick({ tickId: "2026-06-25-21", paperMode: true });
    expect(result.decision.action).toBe("SELL");
    expect(result.trade?.side).toBe("SELL");
    expect(result.trade?.qty).toBeCloseTo(0.001, 9);
  });

  it("az LLM-használat (modell, prompt-verzió, token, idő) mérhető", async () => {
    setLedgerFixture(10000, []);
    mockDecision({ action: "HOLD", confidence: 0.3, reasoning: "csend" });
    const result = await runTick({ tickId: "2026-06-25-22", paperMode: true });
    expect(result.llm).toMatchObject({ model: "glm-5.2", promptVersion: "p2-test", totalTokens: 120 });
  });

  it("phase-1 nemet mond → nincs LLM-használat rögzítve", async () => {
    setLedgerFixture(10000, []);
    (shouldDecide as any).mockResolvedValue({ shouldDecide: false, summary: "csend", notableEvents: [] });
    const result = await runTick({ tickId: "2026-06-25-23", paperMode: true });
    expect(result.llm).toBeNull();
  });

  it("explicit AI-kikapcsolásnál phase-1 és phase-2 hívás sem történik", async () => {
    setLedgerFixture(10000, []);
    const result = await runTick({ tickId: "2026-06-25-shadow", paperMode: true, aiEnabled: false });
    expect(shouldDecide).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(result.llm).toBeNull();
    expect(result.process.phase1.shouldDecide).toBe(false);
  });
});

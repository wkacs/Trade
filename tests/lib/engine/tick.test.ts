import { describe, it, expect, vi, beforeEach } from "vitest";

// Minden külső függőséget mockolunk, hogy a ciklus determinisztikusan tesztelhető legyen
vi.mock("@/lib/collectors/base", () => ({
  collectAll: vi.fn(),
}));
vi.mock("@/lib/collectors/coingecko", () => ({ CoinGeckoCollector: vi.fn() }));
vi.mock("@/lib/collectors/cryptopanic", () => ({ CryptoPanicCollector: vi.fn() }));
vi.mock("@/lib/collectors/whalealert", () => ({ WhaleAlertCollector: vi.fn() }));
vi.mock("@/lib/collectors/rss", () => ({ RSSCollector: vi.fn() }));
vi.mock("@/lib/collectors/binance", () => ({ BinanceOHLCCollector: vi.fn() }));
vi.mock("@/lib/collectors/feargreed", () => ({ FearGreedCollector: vi.fn() }));
vi.mock("@/lib/collectors/reddit", () => ({ RedditCollector: vi.fn() }));
vi.mock("@/lib/llm/phase1-filter", () => ({ shouldDecide: vi.fn() }));
vi.mock("@/lib/llm/phase2-decide", () => ({ decide: vi.fn() }));
vi.mock("@/lib/ml/predictor", () => ({ predict: vi.fn() }));
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

import { collectAll } from "@/lib/collectors/base";
import { shouldDecide } from "@/lib/llm/phase1-filter";
import { decide } from "@/lib/llm/phase2-decide";
import { predict } from "@/lib/ml/predictor";
import { loadPortfolioState } from "@/lib/portfolio/accounting";
import { runTick } from "@/lib/engine/tick";
import type { DataPoint } from "@/lib/types";

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
    (collectAll as any).mockResolvedValue([priceEvent("BTC", 60000)]);
    (predict as any).mockResolvedValue([]);
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
    (decide as any).mockResolvedValue({
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
  });

  it("phase-2 HOLD esetén nincs tranzakció", async () => {
    (shouldDecide as any).mockResolvedValue({
      shouldDecide: true,
      summary: "vegyes",
      notableEvents: [],
    });
    (decide as any).mockResolvedValue({
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
    (decide as any).mockResolvedValue({
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
    (decide as any).mockResolvedValue({
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

import { describe, it, expect, vi, beforeEach } from "vitest";

// Külső függőségek mockolása — a profit-ciklus determinisztikus tesztelése DB nélkül.
vi.mock("@/lib/collectors/base", () => ({ collectAll: vi.fn() }));
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
vi.mock("@/lib/portfolio/accounting", () => ({
  loadPortfolioState: vi.fn(),
  applyTrade: vi.fn().mockResolvedValue({ positionId: "persisted-id" }),
  // A trailing-stop perzisztálását a tick a setStopPrice-on át hívja — a mockban is kell.
  setStopPrice: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/portfolio/evaluate", () => ({
  getPerformanceSummary: vi
    .fn()
    .mockResolvedValue({ evaluated: 0, actionable: 0, hitRate: null, avgHypotheticalPnlPct: 0 }),
  evaluatePending: vi.fn().mockResolvedValue({ evaluated: 0 }),
}));
vi.mock("@/lib/strategy/weekly-budget", () => ({ remainingWeeklyBudget: vi.fn() }));

import { collectAll } from "@/lib/collectors/base";
import { shouldDecide } from "@/lib/llm/phase1-filter";
import { decide } from "@/lib/llm/phase2-decide";
import { predict } from "@/lib/ml/predictor";
import { loadPortfolioState, applyTrade, setStopPrice } from "@/lib/portfolio/accounting";
import { remainingWeeklyBudget } from "@/lib/strategy/weekly-budget";
import { runTick } from "@/lib/engine/tick";
import type { DataPoint } from "@/lib/types";

const price = (symbol: string, usd: number, change24hPct = 0): DataPoint => ({
  source: "coingecko",
  symbol,
  timestamp: Date.now(),
  kind: "price",
  price: { usd, volume24h: 1_000_000, change24hPct },
});

const fearGreed = (value: number): DataPoint => ({
  source: "alternative",
  symbol: "CRYPTO",
  timestamp: Date.now(),
  kind: "sentiment",
  sentiment: { value, classification: value <= 25 ? "Extreme Fear" : "Greed" },
});

const stateWith = (positions: any[], cashUsd = 1000, initialCapitalUsd = 1000) => ({
  cashUsd,
  initialCapitalUsd,
  positions,
  totalEquity: () => cashUsd + positions.reduce((s, p) => s + p.valueUsd, 0),
  dayPnlPct: 0,
});

describe("runTick — profit-ciklus (stop-loss + take-profit + DCA)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TRADING_MODE", "paper");
    (predict as any).mockResolvedValue([]);
    (shouldDecide as any).mockResolvedValue({ shouldDecide: false, summary: "csendes", notableEvents: [] });
    (remainingWeeklyBudget as any).mockResolvedValue(60); // alap: van keret
    (applyTrade as any).mockResolvedValue({ positionId: "persisted-id" });
  });

  it("STOP-LOSS: ár ≤ stopPrice → teljes pozíció SELL, applyTrade-del perzisztálva", async () => {
    (loadPortfolioState as any).mockResolvedValue(
      stateWith([{ id: "p1", symbol: "ETH", qty: 0.1, entryPrice: 2000, stopPrice: 1900, valueUsd: 200 }]),
    );
    // ETH ár 1800 ≤ stop 1900; F&G magas → nincs DCA
    (collectAll as any).mockResolvedValue([price("ETH", 1800, -10), fearGreed(60)]);

    const result = await runTick({ tickId: "2026-06-26-10", paperMode: true });

    const stop = result.cycleActions.find((a) => a.kind === "stop-loss");
    expect(stop).toBeTruthy();
    expect(stop).toMatchObject({ side: "SELL", symbol: "ETH" });
    // teljes pozíció: qty ≈ 0.1
    expect(stop!.qty).toBeCloseTo(0.1, 6);
    // applyTrade kapott egy SELL ETH tradet
    const sells = (applyTrade as any).mock.calls.filter((c: any[]) => c[0].side === "SELL" && c[0].symbol === "ETH");
    expect(sells.length).toBe(1);
  });

  it("TAKE-PROFIT: +15% → a pozíció FELÉNEK SELL-je", async () => {
    (loadPortfolioState as any).mockResolvedValue(
      stateWith([{ id: "p1", symbol: "ETH", qty: 0.1, entryPrice: 2000, stopPrice: 1900, valueUsd: 200 }]),
    );
    // ETH 2300 = +15%, a stop felett; F&G magas → nincs DCA
    (collectAll as any).mockResolvedValue([price("ETH", 2300, 15), fearGreed(60)]);

    const result = await runTick({ tickId: "2026-06-26-11", paperMode: true });

    const tp = result.cycleActions.find((a) => a.kind === "take-profit");
    expect(tp).toBeTruthy();
    expect(tp).toMatchObject({ side: "SELL", symbol: "ETH" });
    // fele: 0.05
    expect(tp!.qty).toBeCloseTo(0.05, 6);
  });

  it("DCA: F&G ≤25 + stabil ár + van keret → BUY 2% tőke a legolcsóbb coinra", async () => {
    (loadPortfolioState as any).mockResolvedValue(stateWith([], 1000)); // nincs pozíció
    // F&G 13 (extrém félelem); BTC -3%, SOL -5% (SOL a leginkább esett, de -8% felett)
    (collectAll as any).mockResolvedValue([
      price("BTC", 60000, -3),
      price("SOL", 150, -5),
      fearGreed(13),
    ]);

    const result = await runTick({ tickId: "2026-06-26-12", paperMode: true });

    const dca = result.cycleActions.find((a) => a.kind === "dca");
    expect(dca).toBeTruthy();
    expect(dca).toMatchObject({ side: "BUY", symbol: "SOL" });
    // 2% az 1000 equity-ből = 20 USD
    expect(dca!.amountUsd).toBeCloseTo(20, 2);
    const buys = (applyTrade as any).mock.calls.filter((c: any[]) => c[0].side === "BUY" && c[0].symbol === "SOL");
    expect(buys.length).toBe(1);
  });

  it("DCA NEM fut, ha nincs heti keret (remaining 0)", async () => {
    (loadPortfolioState as any).mockResolvedValue(stateWith([], 1000));
    (remainingWeeklyBudget as any).mockResolvedValue(0);
    (collectAll as any).mockResolvedValue([price("BTC", 60000, -3), fearGreed(13)]);

    const result = await runTick({ tickId: "2026-06-26-13", paperMode: true });
    expect(result.cycleActions.find((a) => a.kind === "dca")).toBeUndefined();
  });

  it("AI BUY-t a heti limit HOLD-ra váltja, ha a keret elfogyott", async () => {
    (loadPortfolioState as any).mockResolvedValue(stateWith([], 1000));
    (remainingWeeklyBudget as any).mockResolvedValue(0);
    (collectAll as any).mockResolvedValue([price("BTC", 60000, 1), fearGreed(60)]);
    (shouldDecide as any).mockResolvedValue({ shouldDecide: true, summary: "x", notableEvents: [] });
    (decide as any).mockResolvedValue({
      action: "BUY",
      symbol: "BTC",
      amountPct: 0.1,
      confidence: 0.8,
      reasoning: "bullish",
    });

    const result = await runTick({ tickId: "2026-06-26-14", paperMode: true });
    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.overridden).toBe(true);
    expect(result.decision.overrideReason).toMatch(/heti/i);
  });

  it("nincs profit-ciklus akció, ha nincs pozíció és F&G magas", async () => {
    (loadPortfolioState as any).mockResolvedValue(stateWith([], 1000));
    (collectAll as any).mockResolvedValue([price("BTC", 60000, 1), fearGreed(70)]);

    const result = await runTick({ tickId: "2026-06-26-15", paperMode: true });
    expect(result.cycleActions).toEqual([]);
  });

  it("MTM CIRCUIT BREAKER: pozíció aktuális áron ≤ -3% equity → AI BUY HOLD-ra vált", async () => {
    // Kezdőtőke 1000, cash 200, egy ETH pozíció: 0.3 qty @ entry 2000 = 600 entry-érték.
    // Az aktuális ár 1300-ra esett → MTM value = 0.3*1300 = 390.
    // MTM equity = 200 + 390 = 590. dayPnlPct = 590/1000 - 1 = -0.41 = -41% → bőven -3% alatt.
    (loadPortfolioState as any).mockResolvedValue(
      stateWith(
        [{ id: "p1", symbol: "ETH", qty: 0.3, entryPrice: 2000, stopPrice: 1900, valueUsd: 600 }],
        200, // cash
        1000, // initialCapitalUsd
      ),
    );
    (collectAll as any).mockResolvedValue([price("ETH", 1300, -35), fearGreed(60)]);
    (shouldDecide as any).mockResolvedValue({ shouldDecide: true, summary: "x", notableEvents: [] });
    (decide as any).mockResolvedValue({
      action: "BUY",
      symbol: "ETH",
      amountPct: 0.1,
      confidence: 0.8,
      reasoning: "low price",
    });

    const result = await runTick({ tickId: "2026-06-26-16", paperMode: true });
    // A stop 1900 felett van az ár 1300 → előbb stop-loss tüzel (teljes pozíció SELL).
    // Az AI BUY az MTM circuit breaker miatt HOLD-ra vált (-41% < -3%).
    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.overridden).toBe(true);
    expect(result.decision.overrideReason).toMatch(/circuit breaker|napi/i);
  });

  it("TRAILING STOP ratchet: emelkedő árnál a stop felfelé kúszik (setStopPrice), de nem tüzel", async () => {
    // BTC pozíció: 0.01 qty @ entry 60000, stopPrice = 57000 (entry -5%).
    (loadPortfolioState as any).mockResolvedValue(
      stateWith(
        [{ id: "p1", symbol: "BTC", qty: 0.01, entryPrice: 60000, stopPrice: 57000, valueUsd: 600 }],
        9400, // cash → equity ≈ 10000
        10000, // initialCapitalUsd
      ),
    );
    // Ár 65000-re emelkedett → ratchet: stop = 65000*0.95 = 61750 (> 57000).
    // 65000 > 61750, így EBBEN a tickben NEM tüzel a stop — csak a stop kúszik felljebb.
    (collectAll as any).mockResolvedValue([price("BTC", 65000, 5), fearGreed(60)]);

    const result = await runTick({ tickId: "2026-06-26-17", paperMode: true });

    // Nincs stop-loss most (az ár a ratchetelt stop felett van)...
    expect(result.cycleActions.find((a) => a.kind === "stop-loss")).toBeUndefined();
    // ...de a stop felljebb kúszott és perzisztálódott: setStopPrice(p.id, 61750).
    const calls = (setStopPrice as any).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBeCloseTo(61750, 0);
  });

  it("TRAILING STOP védelem: a már ratchetelt (magasabb) stopra visszaeső ár NYERESÉGESEN zár", async () => {
    // A stop egy KORÁBBI tickben már 61750-re kúszott (entry 60000 felett); most az ár
    // 61000-re esik vissza → 61000 ≤ 61750 → stop-loss tüzel, de még nyereségben.
    (loadPortfolioState as any).mockResolvedValue(
      stateWith(
        [{ id: "p1", symbol: "BTC", qty: 0.01, entryPrice: 60000, stopPrice: 61750, valueUsd: 600 }],
        9400,
        10000,
      ),
    );
    (collectAll as any).mockResolvedValue([price("BTC", 61000, -2), fearGreed(60)]);

    const result = await runTick({ tickId: "2026-06-26-18", paperMode: true });

    // Stop-loss tüzel a magasabb (trailing) stopon — a belépő (60000) FELETT zár → védi a nyereséget.
    const stop = result.cycleActions.find((a) => a.kind === "stop-loss");
    expect(stop).toBeTruthy();
    expect(stop).toMatchObject({ side: "SELL", symbol: "BTC" });
    // a ratchet nem mozdult tovább (61000*0.95 = 57950 < 61750), így setStopPrice nem hívódott
    expect((setStopPrice as any).mock.calls.length).toBe(0);
  });
});

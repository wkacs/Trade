import { describe, it, expect } from "vitest";
import { passesMomentum, evaluateMomentum } from "@/lib/strategy/momentum";
import { riskAdjustedRank } from "@/lib/strategy/momentum-ranking";

describe("passesMomentum", () => {
  it("breakout trend fölött → true", () => {
    const closes = [10, 10, 10, 10, 12]; // utolsó = max ÉS > SMA(4)=10.5
    expect(passesMomentum(closes, 4, 5)).toBe(true);
  });
  it("nem új csúcs → false", () => {
    const closes = [10, 14, 11, 12, 13]; // utolsó 13 < 14 (lookback max)
    expect(passesMomentum(closes, 4, 5)).toBe(false);
  });
  it("kevés adat → false", () => {
    expect(passesMomentum([10, 11], 4, 5)).toBe(false);
  });
});

const params = {
  momentumEnabled: true,
  momentumBuyPct: 0.02,
  maxConcurrentPositions: 3,
  riskPerTradePct: 0,
  stopLossPct: 0.05,
  stopMode: "fixed" as const,
  maxPositionPct: 0.2,
};

describe("evaluateMomentum", () => {
  it("kikapcsolva → nincs belépő", () => {
    const sig = evaluateMomentum(
      { momentumOkBySymbol: { BTC: true }, coinChanges: [{ symbol: "BTC", change24hPct: 5 }], heldSymbols: [], openPositionCount: 0, totalEquity: 1000 },
      { ...params, momentumEnabled: false },
    );
    expect(sig.shouldEnter).toBe(false);
  });
  it("a legerősebb (legnagyobb 24h) momentum-coint választja, flat méret", () => {
    const sig = evaluateMomentum(
      { momentumOkBySymbol: { BTC: true, ETH: true }, coinChanges: [{ symbol: "BTC", change24hPct: 3 }, { symbol: "ETH", change24hPct: 6 }], heldSymbols: [], openPositionCount: 0, totalEquity: 1000 },
      params,
    );
    expect(sig.shouldEnter).toBe(true);
    expect(sig.symbol).toBe("ETH");
    expect(sig.amountUsd).toBeCloseTo(20); // flat 2%
  });
  it("már tartott coin kiesik", () => {
    const sig = evaluateMomentum(
      { momentumOkBySymbol: { BTC: true }, coinChanges: [{ symbol: "BTC", change24hPct: 5 }], heldSymbols: ["BTC"], openPositionCount: 1, totalEquity: 1000 },
      params,
    );
    expect(sig.shouldEnter).toBe(false);
  });
  it("concurrent-cap elérve → nincs új belépő", () => {
    const sig = evaluateMomentum(
      { momentumOkBySymbol: { BTC: true }, coinChanges: [{ symbol: "BTC", change24hPct: 5 }], heldSymbols: ["ETH", "SOL", "XRP"], openPositionCount: 3, totalEquity: 1000 },
      params,
    );
    expect(sig.shouldEnter).toBe(false);
  });
});

// ── Cserélhető rangsor (a szélesebb univerzum kiválasztási kérdése) ──────────────

describe("evaluateMomentum – cserélhető rangsor", () => {
  const ctx = {
    momentumOkBySymbol: { AAPL: true, COIN: true },
    coinChanges: [
      { symbol: "AAPL", change24hPct: 3, atrPct: 1 },
      { symbol: "COIN", change24hPct: 6, atrPct: 8 },
    ],
    heldSymbols: [],
    openPositionCount: 0,
    totalEquity: 1000,
  };

  it("rangsor nélkül a nyers százalék-maximum nyer (változatlan viselkedés)", () => {
    expect(evaluateMomentum(ctx, params).symbol).toBe("COIN");
  });

  it("kockázat-korrigált rangsorral a nyugodtabb papír nyer", () => {
    const sig = evaluateMomentum(ctx, { ...params, rankBy: riskAdjustedRank });
    expect(sig.shouldEnter).toBe(true);
    expect(sig.symbol).toBe("AAPL");
  });

  it("ha EGYIK jelölt sem rangsorolható, NINCS belépő (nem választ vaktában)", () => {
    const sig = evaluateMomentum(
      {
        ...ctx,
        coinChanges: [
          { symbol: "AAPL", change24hPct: 3 },
          { symbol: "COIN", change24hPct: 6 },
        ],
      },
      { ...params, rankBy: riskAdjustedRank },
    );
    expect(sig.shouldEnter).toBe(false);
    expect(sig.symbol).toBeNull();
  });

  it("a rangsorolhatatlan jelölt kiesik, a rangsorolható marad", () => {
    const sig = evaluateMomentum(
      {
        ...ctx,
        coinChanges: [
          { symbol: "AAPL", change24hPct: 3 },
          { symbol: "COIN", change24hPct: 6, atrPct: 8 },
        ],
      },
      { ...params, rankBy: riskAdjustedRank },
    );
    expect(sig.symbol).toBe("COIN");
  });
});

import { describe, it, expect } from "vitest";
import { evaluateDca } from "@/lib/strategy/fear-greedy";

const ctx = (over: Partial<Parameters<typeof evaluateDca>[0]> = {}) => ({
  fearGreedValue: 13,
  coinChanges: [
    { symbol: "BTC", change24hPct: -3 },
    { symbol: "ETH", change24hPct: -1 },
    { symbol: "SOL", change24hPct: -5 },
  ],
  weeklyBudgetRemainingUsd: 4,
  totalEquity: 27,
  ...over,
});

describe("evaluateDca — fear-greedy DCA halmozás", () => {
  it("F&G alacsony + stabil ár + van keret → halmoz (BUY)", () => {
    const s = evaluateDca(ctx());
    expect(s.shouldAccumulate).toBe(true);
    expect(s.amountUsd).toBeCloseTo(27 * 0.02, 6); // 2% tőke
  });

  it("a leginkább esett (legolcsóbb relatíve) coint választja a -8% felettiek közül", () => {
    // SOL -5% a leginkább esett, de még a -8% küszöb felett → őt választja
    const s = evaluateDca(ctx());
    expect(s.symbol).toBe("SOL");
  });

  it("F&G alacsony + zuhanó ár (mind < -8%) → NEM halmoz", () => {
    const s = evaluateDca(
      ctx({
        coinChanges: [
          { symbol: "BTC", change24hPct: -9 },
          { symbol: "ETH", change24hPct: -12 },
          { symbol: "SOL", change24hPct: -20 },
        ],
      }),
    );
    expect(s.shouldAccumulate).toBe(false);
    expect(s.symbol).toBeNull();
  });

  it("a -8% alatt zuhanó coint kihagyja, de a stabilt választja", () => {
    const s = evaluateDca(
      ctx({
        coinChanges: [
          { symbol: "BTC", change24hPct: -15 }, // szabaduló zuhanás → kihagy
          { symbol: "ETH", change24hPct: -2 }, // ezt választja
        ],
      }),
    );
    expect(s.shouldAccumulate).toBe(true);
    expect(s.symbol).toBe("ETH");
  });

  it("F&G magas (>25, nem elég olcsó a piac) → NEM halmoz", () => {
    const s = evaluateDca(ctx({ fearGreedValue: 60 }));
    expect(s.shouldAccumulate).toBe(false);
  });

  it("pont 25 F&G még halmoz (≤ küszöb)", () => {
    const s = evaluateDca(ctx({ fearGreedValue: 25 }));
    expect(s.shouldAccumulate).toBe(true);
  });

  it("heti keret elfogyott (≤0) → NEM halmoz", () => {
    const s = evaluateDca(ctx({ weeklyBudgetRemainingUsd: 0 }));
    expect(s.shouldAccumulate).toBe(false);
  });

  it("nincs F&G adat (null) → NEM vak-vásárol", () => {
    const s = evaluateDca(ctx({ fearGreedValue: null }));
    expect(s.shouldAccumulate).toBe(false);
  });

  it("üres coin-lista → NEM halmoz", () => {
    const s = evaluateDca(ctx({ coinChanges: [] }));
    expect(s.shouldAccumulate).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { evaluateDca } from "@/lib/strategy/fear-greedy";

// Mai default DCA-paraméterek (parity).
const P = { dcaFgThreshold: 25, dcaMax24hDropPct: 0.08, dcaBuyPct: 0.02, entryFilter: "off" as const };

const ctx = (over: Partial<Parameters<typeof evaluateDca>[0]> = {}) => ({
  fearGreedValue: 13,
  coinChanges: [
    { symbol: "BTC", change24hPct: -3 },
    { symbol: "ETH", change24hPct: -1 },
    { symbol: "SOL", change24hPct: -5 },
  ],
  weeklyBudgetRemainingUsd: 200,
  totalEquity: 1000,
  ...over,
});

describe("evaluateDca — fear-greedy DCA halmozás", () => {
  it("F&G alacsony + stabil ár + van keret → halmoz (BUY)", () => {
    const s = evaluateDca(ctx(), P);
    expect(s.shouldAccumulate).toBe(true);
    expect(s.amountUsd).toBeCloseTo(1000 * 0.02, 6); // 2% tőke
  });

  it("a leginkább esett (legolcsóbb relatíve) coint választja a -8% felettiek közül", () => {
    const s = evaluateDca(ctx(), P);
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
      P,
    );
    expect(s.shouldAccumulate).toBe(false);
    expect(s.symbol).toBeNull();
  });

  it("a -8% alatt zuhanó coint kihagyja, de a stabilt választja", () => {
    const s = evaluateDca(
      ctx({
        coinChanges: [
          { symbol: "BTC", change24hPct: -15 },
          { symbol: "ETH", change24hPct: -2 },
        ],
      }),
      P,
    );
    expect(s.shouldAccumulate).toBe(true);
    expect(s.symbol).toBe("ETH");
  });

  it("F&G magas (>25, nem elég olcsó a piac) → NEM halmoz", () => {
    const s = evaluateDca(ctx({ fearGreedValue: 60 }), P);
    expect(s.shouldAccumulate).toBe(false);
  });

  it("pont 25 F&G még halmoz (≤ küszöb)", () => {
    const s = evaluateDca(ctx({ fearGreedValue: 25 }), P);
    expect(s.shouldAccumulate).toBe(true);
  });

  it("heti keret elfogyott (≤0) → NEM halmoz", () => {
    const s = evaluateDca(ctx({ weeklyBudgetRemainingUsd: 0 }), P);
    expect(s.shouldAccumulate).toBe(false);
  });

  it("nincs F&G adat (null) → NEM vak-vásárol", () => {
    const s = evaluateDca(ctx({ fearGreedValue: null }), P);
    expect(s.shouldAccumulate).toBe(false);
  });

  it("üres coin-lista → NEM halmoz", () => {
    const s = evaluateDca(ctx({ coinChanges: [] }), P);
    expect(s.shouldAccumulate).toBe(false);
  });

  // ── Belépő-szűrő (trend) ──
  it("trend módban a lefelé trendben lévő coin kiesik", () => {
    const s = evaluateDca(
      ctx({ coinChanges: [{ symbol: "BTC", change24hPct: -3 }], trendOkBySymbol: { BTC: false } }),
      { ...P, entryFilter: "trend" },
    );
    expect(s.shouldAccumulate).toBe(false);
  });

  it("off módban a trendOk flaget figyelmen kívül hagyja", () => {
    const s = evaluateDca(
      ctx({ coinChanges: [{ symbol: "BTC", change24hPct: -3 }], trendOkBySymbol: { BTC: false } }),
      { ...P, entryFilter: "off" },
    );
    expect(s.shouldAccumulate).toBe(true);
  });

  // ── T08: a terv soha nem lépheti túl a heti maradékot ──
  it("AUDIT §4: 1 USD maradék mellett LEGFELJEBB 1 USD tervezhető (nem 2 USD)", () => {
    // A régi kód csak azt nézte, pozitív-e a maradék, és 2%-nyi (20 USD) vételt tervezett.
    const s = evaluateDca(ctx({ weeklyBudgetRemainingUsd: 1 }), P);
    expect(s.shouldAccumulate).toBe(true);
    expect(s.amountUsd).toBe(1);
    expect(s.reason).toMatch(/heti keret marad/i);
  });

  it("ha a maradék a minimum kötésérték alatt van, NINCS kötés", () => {
    const s = evaluateDca(ctx({ weeklyBudgetRemainingUsd: 0.4 }), P);
    expect(s.shouldAccumulate).toBe(false);
    expect(s.amountUsd).toBe(0);
    expect(s.reason).toMatch(/minimum/i);
  });

  it("a minimum kötésérték paraméterezhető", () => {
    const s = evaluateDca(ctx({ weeklyBudgetRemainingUsd: 3 }), { ...P, minOrderUsd: 5 });
    expect(s.shouldAccumulate).toBe(false);
  });

  it("bőséges maradéknál a tervezett méret a 2%-os alapméret marad", () => {
    const s = evaluateDca(ctx({ weeklyBudgetRemainingUsd: 999 }), P);
    expect(s.amountUsd).toBeCloseTo(20, 9);
    expect(s.reason).not.toMatch(/vágva/);
  });
});

import { describe, it, expect } from "vitest";
import { scoreDecision, priceAtHorizon, evaluatePending, getPerformanceSummary, type DecisionRef, type PricePoint } from "@/lib/portfolio/evaluate";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 5, 10, 0, 0);

const ref = (over: Partial<DecisionRef> = {}): DecisionRef => ({
  prices: { BTC: 100, ETH: 50 },
  intent: "BUY",
  intentSymbol: "BTC",
  intentAmountPct: 0.1,
  ...over,
});

describe("scoreDecision — IRÁNY-diagnosztika a HORIZONT árán (T20)", () => {
  it("BUY szándék emelkedő árnál iránytalálat", () => {
    const o = scoreDecision(ref(), { price: 110, atMs: T0 + HOUR }, T0);
    expect(o.changePct).toBeCloseTo(10, 6);
    expect(o.directionalScorePct).toBeCloseTo(10, 6);
    expect(o.directionHit).toBe(true);
    expect(o.unscored).toBeUndefined();
  });

  it("SELL szándék eső árnál iránytalálat", () => {
    const o = scoreDecision(ref({ intent: "SELL", intentSymbol: "ETH", prices: { ETH: 50 } }), { price: 45, atMs: T0 + HOUR }, T0);
    expect(o.changePct).toBeCloseTo(-10, 6);
    expect(o.directionalScorePct).toBeCloseTo(10, 6);
    expect(o.directionHit).toBe(true);
  });

  it("BUY szándék eső árnál NEM találat", () => {
    const o = scoreDecision(ref(), { price: 90, atMs: T0 + HOUR }, T0);
    expect(o.directionHit).toBe(false);
    expect(o.directionalScorePct).toBeCloseTo(-10, 6);
  });

  it("HOLD szándék nem pontozható (semleges)", () => {
    const o = scoreDecision(ref({ intent: "HOLD", intentSymbol: null }), { price: 110, atMs: T0 + HOUR }, T0);
    expect(o.directionHit).toBeNull();
    expect(o.unscored).toBe("no_intent");
  });

  it("AUDIT: több napos üzemszünet utáni ár NEM pontoz 1 órás döntést", () => {
    const o = scoreDecision(ref(), { price: 200, atMs: T0 + 72 * HOUR }, T0);
    expect(o.unscored).toBe("stale_horizon");
    expect(o.directionHit).toBeNull();
    expect(o.horizonErrorHours).toBeCloseTo(71, 6);
  });

  it("hiányzó horizont-ár esetén nincs kitalált pontszám", () => {
    const o = scoreDecision(ref(), { price: null, atMs: null }, T0);
    expect(o.unscored).toBe("missing_price");
    expect(o.changePct).toBe(0);
  });

  it("hiányzó döntéskori ár esetén sem pontozunk", () => {
    const o = scoreDecision(ref({ prices: {} }), { price: 110, atMs: T0 + HOUR }, T0);
    expect(o.unscored).toBe("missing_price");
  });

  it("a tűréshatár állítható, és a horizont a CÉLZOTT érték marad", () => {
    const o = scoreDecision(ref(), { price: 110, atMs: T0 + 2 * HOUR }, T0, { horizonHours: 2 });
    expect(o.horizonHours).toBe(2);
    expect(o.directionHit).toBe(true);
  });

  it("az iránypontszám NEM azonos a profitmutatóval (nincs ilyen mező)", () => {
    const o = scoreDecision(ref(), { price: 110, atMs: T0 + HOUR }, T0);
    expect(Object.keys(o)).not.toContain("hypotheticalPnlPct");
    expect(Object.keys(o)).not.toContain("wouldProfit");
    expect(Object.keys(o)).toContain("directionalScorePct");
  });
});

describe("priceAtHorizon — a HORIZONT ára, nem a legfrissebb", () => {
  const series: PricePoint[] = [
    { ts: T0, price: 100 },
    { ts: T0 + HOUR, price: 110 },
    { ts: T0 + 5 * HOUR, price: 300 },
  ];

  it("a célidőhöz legközelebbi pontot adja a tűréshatáron belül", () => {
    expect(priceAtHorizon(series, T0, 1)).toEqual({ price: 110, atMs: T0 + HOUR });
  });

  it("a tűréshatáron kívüli pontot NEM használja (nem a legfrissebbet adja)", () => {
    const sparse: PricePoint[] = [
      { ts: T0, price: 100 },
      { ts: T0 + 5 * HOUR, price: 300 },
    ];
    expect(priceAtHorizon(sparse, T0, 1)).toEqual({ price: null, atMs: null });
  });

  it("üres sorozatra null", () => {
    expect(priceAtHorizon([], T0, 1)).toEqual({ price: null, atMs: null });
  });
});

describe("DB-wrapperek (null DB → biztonságos default)", () => {
  it("evaluatePending null DB → 0", async () => {
    expect(await evaluatePending({})).toEqual({ evaluated: 0, unscored: 0 });
  });

  it("getPerformanceSummary null DB → üres összegzés", async () => {
    const s = await getPerformanceSummary();
    expect(s.evaluated).toBe(0);
    expect(s.hitRate).toBeNull();
  });
});

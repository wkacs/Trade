import { describe, it, expect } from "vitest";
import { contextRowsFromEvents, hourBucket } from "@/lib/market/context-store";
import type { DataPoint } from "@/lib/types";

const NOW = Date.UTC(2026, 8, 6, 18, 42, 17);

const deriv = (symbol: string, over: Partial<NonNullable<DataPoint["derivatives"]>> = {}): DataPoint => ({
  source: "binance-futures",
  symbol,
  timestamp: NOW,
  kind: "derivatives",
  derivatives: {
    fundingRatePct: 0.0028,
    openInterestBase: 106402,
    openInterestUsd: 8477888632,
    openInterestChange1hPct: 1.2,
    takerBuySellRatio: 1.07,
    longShortAccountRatio: 1.05,
    ...over,
  },
});

const premium = (symbol: string, pct: number): DataPoint => ({
  source: "coinbase",
  symbol,
  timestamp: NOW,
  kind: "premium",
  premium: { venue: "coinbase", venuePrice: 1, referencePrice: 1, premiumPct: pct },
});

describe("hourBucket", () => {
  it("órára kerekít lefelé — óránként EGY sor coinonként", () => {
    expect(hourBucket(NOW).toISOString()).toBe("2026-09-06T18:00:00.000Z");
  });
});

describe("contextRowsFromEvents", () => {
  it("coinonként egy sorba fésüli a derivatíva- és a prémium-adatot", () => {
    const rows = contextRowsFromEvents([deriv("BTC"), premium("BTC", 0.5)], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "BTC", fundingRatePct: 0.0028, premiumPct: 0.5 });
    expect(rows[0].ts.toISOString()).toBe("2026-09-06T18:00:00.000Z");
  });

  it("külön coinok NEM keverednek", () => {
    const rows = contextRowsFromEvents(
      [deriv("BTC", { fundingRatePct: 0.01 }), deriv("ETH", { fundingRatePct: -0.02 }), premium("ETH", -0.3)],
      NOW,
    );
    const byS = Object.fromEntries(rows.map((r) => [r.symbol, r]));
    expect(byS.BTC.fundingRatePct).toBeCloseTo(0.01, 6);
    expect(byS.ETH.fundingRatePct).toBeCloseTo(-0.02, 6);
    expect(byS.BTC.premiumPct).toBeNull();
    expect(byS.ETH.premiumPct).toBeCloseTo(-0.3, 6);
  });

  it("csupa-null sort nem ír: az üres rekord hígítaná a tanítóadatot", () => {
    const empty: DataPoint = { source: "coingecko", symbol: "SOL", timestamp: NOW, kind: "price", price: { usd: 1, volume24h: 1, change24hPct: 0 } };
    expect(contextRowsFromEvents([empty], NOW)).toEqual([]);
  });

  it("hiányzó mező null marad, nem nulla — a nulla funding valós érték", () => {
    const rows = contextRowsFromEvents([deriv("BTC", { openInterestChange1hPct: null })], NOW);
    expect(rows[0].openInterestChange1hPct).toBeNull();
    expect(rows[0].premiumPct).toBeNull();
  });
});

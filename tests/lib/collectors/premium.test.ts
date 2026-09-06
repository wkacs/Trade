import { describe, it, expect } from "vitest";
import { CoinbasePremiumCollector, premiumPct } from "@/lib/collectors/premium";

describe("premiumPct", () => {
  it("a Coinbase (USD) és a Binance (USDT) ár különbsége százalékban", () => {
    expect(premiumPct(80400, 80000)).toBeCloseTo(0.5, 6);
    expect(premiumPct(79600, 80000)).toBeCloseTo(-0.5, 6);
  });

  it("érvénytelen referenciára null, nem végtelen", () => {
    expect(premiumPct(80000, 0)).toBeNull();
    expect(premiumPct(Number.NaN, 80000)).toBeNull();
  });
});

describe("CoinbasePremiumCollector", () => {
  const ok = (async (url: string) =>
    url.includes("coinbase")
      ? new Response(JSON.stringify({ price: "80400.00", volume: "1910.75" }), { status: 200 })
      : new Response(JSON.stringify({ symbol: "BTCUSDT", price: "80000.00" }), { status: 200 })) as unknown as typeof fetch;

  it("symbolonként prémium-adatpontot ad", async () => {
    const c = new CoinbasePremiumCollector(["BTC"], { fetchImpl: ok });
    const points = await c.collect();
    expect(points).toHaveLength(1);
    expect(points[0].kind).toBe("premium");
    expect(points[0].source).toBe("coinbase");
    expect(points[0].premium?.premiumPct).toBeCloseTo(0.5, 4);
    expect(points[0].premium?.venuePrice).toBeCloseTo(80400, 2);
    expect(c.lastError()).toBeNull();
  });

  it("NEM ad 'price' adatpontot — nem keveredhet a végrehajtási ár forrásaiba", async () => {
    const c = new CoinbasePremiumCollector(["BTC"], { fetchImpl: ok });
    const points = await c.collect();
    expect(points.every((p) => p.kind !== "price")).toBe(true);
  });

  it("hiba esetén strukturáltan jelent, és nem dob", async () => {
    const bad = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const c = new CoinbasePremiumCollector(["BTC"], { fetchImpl: bad });
    expect(await c.collect()).toHaveLength(0);
    expect(c.lastError()).toContain("503");
  });
});

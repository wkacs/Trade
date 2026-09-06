import { describe, it, expect } from "vitest";
import {
  BinanceDerivativesCollector,
  parseFundingRate,
  parseOpenInterest,
  parseTakerRatio,
  parseLongShortRatio,
} from "@/lib/collectors/derivatives";

/** A Binance futures válaszok VALÓDI alakja (2026-09-06-i élő mintavétel). */
const fundingRows = [{ symbol: "BTCUSDT", fundingTime: 1788710400004, fundingRate: "0.00002813", markPrice: "79677.8" }];
const oiRows = [
  { symbol: "BTCUSDT", sumOpenInterest: "106402.009", sumOpenInterestValue: "8477888632.9", timestamp: 1788710400000 },
  { symbol: "BTCUSDT", sumOpenInterest: "107466.03", sumOpenInterestValue: "8547057845.0", timestamp: 1788714000000 },
];
const takerRows = [{ buySellRatio: "1.0698", sellVol: "992.498", buyVol: "1061.776", timestamp: 1788710400000 }];
const lsRows = [{ symbol: "BTCUSDT", longAccount: "0.5132", longShortRatio: "1.0542", shortAccount: "0.4868", timestamp: 1788714000000 }];

describe("derivatíva-válaszok értelmezése", () => {
  it("a funding rate százalékban jön ki, nem törtben", () => {
    // 0.00002813 arány = 0.002813%
    expect(parseFundingRate(fundingRows)).toBeCloseTo(0.002813, 6);
  });

  it("az OI változása az előző órás mintához mérve számol", () => {
    const oi = parseOpenInterest(oiRows);
    expect(oi.openInterestBase).toBeCloseTo(107466.03, 2);
    expect(oi.openInterestUsd).toBeCloseTo(8547057845, 0);
    // (107466.03 - 106402.009) / 106402.009 = +1.0%
    expect(oi.openInterestChange1hPct).toBeCloseTo(1.0, 1);
  });

  it("egyetlen OI-mintából nincs kitalált változás", () => {
    expect(parseOpenInterest([oiRows[0]]).openInterestChange1hPct).toBeNull();
  });

  it("üres válaszból null lesz, nem nulla", () => {
    expect(parseFundingRate([])).toBeNull();
    expect(parseTakerRatio([])).toBeNull();
    expect(parseLongShortRatio([])).toBeNull();
    expect(parseOpenInterest([]).openInterestBase).toBeNull();
  });

  it("a taker- és a long/short arány számmá alakul", () => {
    expect(parseTakerRatio(takerRows)).toBeCloseTo(1.0698, 4);
    expect(parseLongShortRatio(lsRows)).toBeCloseTo(1.0542, 4);
  });
});

describe("BinanceDerivativesCollector", () => {
  const routing = async (url: string) => {
    if (url.includes("fundingRate")) return new Response(JSON.stringify(fundingRows), { status: 200 });
    if (url.includes("openInterestHist")) return new Response(JSON.stringify(oiRows), { status: 200 });
    if (url.includes("takerlongshortRatio")) return new Response(JSON.stringify(takerRows), { status: 200 });
    if (url.includes("globalLongShortAccountRatio")) return new Response(JSON.stringify(lsRows), { status: 200 });
    return new Response("[]", { status: 404 });
  };

  it("symbolonként EGY adatpontot ad, minden mezővel", async () => {
    const c = new BinanceDerivativesCollector(["BTC"], { fetchImpl: routing as unknown as typeof fetch });
    const points = await c.collect();
    expect(points).toHaveLength(1);
    expect(points[0].source).toBe("binance-futures");
    expect(points[0].kind).toBe("derivatives");
    expect(points[0].derivatives).toMatchObject({
      fundingRatePct: expect.any(Number),
      openInterestChange1hPct: expect.any(Number),
      takerBuySellRatio: expect.any(Number),
      longShortAccountRatio: expect.any(Number),
    });
    expect(c.lastError()).toBeNull();
  });

  it("HTTP hibát strukturáltan jelent, és nem dob", async () => {
    const failing = (async () => new Response("nope", { status: 418 })) as unknown as typeof fetch;
    const c = new BinanceDerivativesCollector(["BTC"], { fetchImpl: failing });
    const points = await c.collect();
    expect(points).toHaveLength(0);
    expect(c.lastError()).toContain("418");
  });

  it("részleges hiba esetén a meglévő mezők megmaradnak", async () => {
    const partial = (async (url: string) =>
      url.includes("openInterestHist")
        ? new Response("boom", { status: 500 })
        : await routing(url)) as unknown as typeof fetch;
    const c = new BinanceDerivativesCollector(["BTC"], { fetchImpl: partial });
    const points = await c.collect();
    expect(points).toHaveLength(1);
    expect(points[0].derivatives?.openInterestBase).toBeNull();
    expect(points[0].derivatives?.fundingRatePct).not.toBeNull();
    expect(c.lastError()).toContain("500");
  });
});

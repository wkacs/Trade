import { describe, it, expect } from "vitest";
import { pricesFromEvents, binancePrices } from "@/lib/market/price-view";
import type { DataPoint } from "@/lib/types";

function cg(symbol: string, usd: number, change: number): DataPoint {
  return {
    source: "coingecko",
    symbol,
    timestamp: 1_000,
    kind: "price",
    price: { usd, volume24h: 1, change24hPct: change },
  };
}

/** `bars` darab órás Binance-gyertya, az `closes` sorrendjében (a legutolsó a legfrissebb). */
function binance(symbol: string, closes: number[]): DataPoint[] {
  const hour = 60 * 60 * 1000;
  return closes.map((close, i) => ({
    source: "binance" as const,
    symbol,
    timestamp: i * hour,
    kind: "price" as const,
    price: { usd: close, volume24h: 1, change24hPct: 0 },
  }));
}

describe("market/price-view – a felület sosem marad ár nélkül", () => {
  it("a CoinGecko ára nyer, ha megvan", () => {
    const prices = pricesFromEvents([cg("BTC", 60_000, 2.5), ...binance("BTC", [59_000, 59_500])]);
    expect(prices.BTC).toEqual({ usd: 60_000, change24hPct: 2.5, source: "coingecko" });
  });

  it("CoinGecko nélkül a Binance LEZÁRT gyertyája adja az árat — nem marad üres a tábla", () => {
    // 25 gyertya: az utolsó 110, a 24-gyel korábbi 100 → +10%.
    const closes = [100, ...Array.from({ length: 23 }, (_, i) => 101 + i), 110];
    const prices = pricesFromEvents(binance("ETH", closes));
    expect(prices.ETH.usd).toBe(110);
    expect(prices.ETH.change24hPct).toBeCloseTo(10, 6);
    expect(prices.ETH.source).toBe("binance");
  });

  it("coinonként pótol: a meglévő CoinGecko-ár marad, a hiányzó Binance-ból jön", () => {
    const prices = pricesFromEvents([cg("BTC", 60_000, 1), ...binance("SOL", [150, 155])]);
    expect(prices.BTC.source).toBe("coingecko");
    expect(prices.SOL).toMatchObject({ usd: 155, source: "binance" });
  });

  it("24 gyertyás referencia nélkül a változás 0 — nem kitalált szám", () => {
    expect(binancePrices(binance("BTC", [100, 120])).BTC).toMatchObject({ usd: 120, change24hPct: 0 });
  });

  it("rendezetlen sorrendben is a LEGFRISSEBB gyertya zárója nyer", () => {
    const points = binance("BTC", [100, 200]).reverse();
    expect(binancePrices(points).BTC.usd).toBe(200);
  });

  it("egyik forrás sincs: üres tábla (a hívó ebből tudja, hogy nincs ár)", () => {
    expect(pricesFromEvents([])).toEqual({});
  });
});

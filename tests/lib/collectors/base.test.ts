import { describe, it, expect } from "vitest";
import { collectAll, type DataCollector } from "@/lib/collectors/base";
import type { DataPoint } from "@/lib/types";

describe("collectAll", () => {
  it("üres lista esetén üres eredményt ad", async () => {
    const result = await collectAll([]);
    expect(result).toEqual([]);
  });

  it("több collector eredményét egyesíti", async () => {
    const fakeCollector: DataCollector = {
      name: "fake",
      collect: async () => [
        { source: "coingecko", symbol: "BTC", timestamp: 1, kind: "price", price: { usd: 100, volume24h: 1, change24hPct: 0 } },
      ],
    };
    const result = await collectAll([fakeCollector]);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("BTC");
  });

  it("egy collector hibája nem dönti romba a többit", async () => {
    const good: DataCollector = {
      name: "good",
      collect: async () => [
        { source: "coingecko", symbol: "ETH", timestamp: 1, kind: "price", price: { usd: 50, volume24h: 1, change24hPct: 0 } },
      ],
    };
    const bad: DataCollector = {
      name: "bad",
      collect: async () => {
        throw new Error("api down");
      },
    };
    const result = await collectAll([good, bad]);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("ETH");
  });

  it("DataPoint típus konzisztens", () => {
    const dp: DataPoint = { source: "rss", symbol: "BTC", timestamp: 1, kind: "rss" };
    expect(dp.kind).toBe("rss");
  });
});

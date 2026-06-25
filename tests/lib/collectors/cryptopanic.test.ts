import { describe, it, expect, vi, beforeEach } from "vitest";
import { CryptoPanicCollector } from "@/lib/collectors/cryptopanic";

describe("CryptoPanicCollector", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("híreket sentiment-té normalizál", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: "BTC ETF inflow record", url: "https://x/1", currency: { code: "BTC" }, votes: { positive: 10, negative: 1, important: 5 } },
          { title: "ETH hack", url: "https://x/2", currency: { code: "ETH" }, votes: { positive: 0, negative: 8, important: 3 } },
          { title: "neutral news", url: "https://x/3", currency: { code: "BTC" }, votes: { positive: 2, negative: 2, important: 1 } },
        ],
      }),
    });
    const c = new CryptoPanicCollector("dummy-token", ["BTC", "ETH"]);
    const result = await c.collect();
    expect(result).toHaveLength(3);
    expect(result[0].news?.sentiment).toBe("bullish");
    expect(result[1].news?.sentiment).toBe("bearish");
    expect(result[2].news?.sentiment).toBe("neutral");
  });

  it("API hiba esetén üres listát ad", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const c = new CryptoPanicCollector("tok", ["BTC"]);
    expect(await c.collect()).toEqual([]);
  });
});

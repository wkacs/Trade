import { describe, it, expect, vi, beforeEach } from "vitest";
import { BinanceOHLCCollector } from "@/lib/collectors/binance";

describe("BinanceOHLCCollector", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("klines gyertyákat price DataPoint-tá alakít (close + change%)", async () => {
    // Binance kline tömb: [openTime, open, high, low, close, volume, closeTime, ...]
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [
        [1000, "100", "110", "95", "108", "50", 1100],
        [1100, "108", "120", "107", "115", "60", 1200],
      ],
    });
    const r = await new BinanceOHLCCollector(["BTC"]).collect();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ source: "binance", symbol: "BTC", kind: "price" });
    expect(r[0].price?.usd).toBe(108);
    expect(r[0].timestamp).toBe(1100);
    // change% = (108 - 100) / 100 * 100 = 8
    expect(r[0].price?.change24hPct).toBeCloseTo(8, 6);
    expect(r[1].price?.usd).toBe(115);
  });

  it("API hiba esetén üres listát ad (nem dob)", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 429 });
    const r = await new BinanceOHLCCollector(["BTC"]).collect();
    expect(r).toEqual([]);
  });
});

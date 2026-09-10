import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoinGeckoCollector } from "@/lib/collectors/coingecko";

describe("CoinGeckoCollector", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("árat normalizál DataPoint-tá", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        bitcoin: { usd: 60000, usd_24h_vol: 5_000_000_000, usd_24h_change: 2.5 },
        ethereum: { usd: 3000, usd_24h_vol: 1_000_000_000, usd_24h_change: -1.2 },
        solana: { usd: 150, usd_24h_vol: 200_000_000, usd_24h_change: 0.5 },
      }),
    });

    const collector = new CoinGeckoCollector(["BTC", "ETH", "SOL"]);
    const result = await collector.collect();

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      source: "coingecko",
      symbol: "BTC",
      kind: "price",
      price: { usd: 60000, volume24h: 5_000_000_000, change24hPct: 2.5 },
    });
    expect(result[1].symbol).toBe("ETH");
    expect(result[2].symbol).toBe("SOL");
  });

  it("API hiba esetén üres listát ad (nem dob)", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const collector = new CoinGeckoCollector(["BTC"]);
    const result = await collector.collect();
    expect(result).toEqual([]);
  });

  // A néma degradáció ITT lett látható hibává. Enélkül a collectAllWithOutcomes
  // `ok: true, points: 0`-t jelentett: a dashboard „rendben" forrást mutatott, miközben
  // ár nélkül maradt, és a nyitott pozíció P&L-je belépési áron ragadt.
  it("a rate limit MEGNEVEZETT hiba, nem néma üres válasz", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const collector = new CoinGeckoCollector(["BTC"]);
    await collector.collect();
    expect(collector.lastError()).toContain("429");
    expect(collector.lastError()).toContain("rate limit");
  });

  it("hálózati hiba is megnevezett hiba", async () => {
    (global.fetch as any).mockRejectedValue(new Error("időtúllépés"));
    const collector = new CoinGeckoCollector(["BTC"]);
    expect(await collector.collect()).toEqual([]);
    expect(collector.lastError()).toContain("időtúllépés");
  });

  it("RÉSZLEGES válasz is hiba: a hiányzó coint megnevezi", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { usd: 60000, usd_24h_vol: 1, usd_24h_change: 0 } }),
    });
    const collector = new CoinGeckoCollector(["BTC", "ETH"]);
    expect(await collector.collect()).toHaveLength(1);
    expect(collector.lastError()).toContain("ETH");
  });

  it("teljes válasz után NINCS hiba (a helyreállás is látszik)", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { usd: 60000, usd_24h_vol: 1, usd_24h_change: 0 } }),
    });
    const collector = new CoinGeckoCollector(["BTC"]);
    await collector.collect();
    expect(collector.lastError()).toBeNull();
  });

  it("ismeretlen szimbólumot kihagy", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { usd: 60000, usd_24h_vol: 1, usd_24h_change: 0 } }),
    });
    const collector = new CoinGeckoCollector(["BTC", "UNKNOWN"]);
    const result = await collector.collect();
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("BTC");
  });
});

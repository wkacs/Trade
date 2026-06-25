import { describe, it, expect, vi, beforeEach } from "vitest";
import { WhaleAlertCollector } from "@/lib/collectors/whalealert";

describe("WhaleAlertCollector", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("nagy tranzakciókat irányként normalizál", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          { symbol: "BTC", amount_usd: 1_500_000, blockchain: "bitcoin", from: { owner: "unknown" }, to: { owner: "binance" } },
          { symbol: "ETH", amount_usd: 800_000, from: { owner: "kraken" }, to: { owner: "unknown" } },
          { symbol: "USDT", amount_usd: 999_999, from: { owner: "binance" }, to: { owner: "kraken" } },
        ],
      }),
    });
    const c = new WhaleAlertCollector("tok", ["BTC", "ETH"]);
    const r = await c.collect();
    // USDT ki van szűrve (nem a kosárban)
    expect(r).toHaveLength(2);
    expect(r[0].whale?.direction).toBe("exchange-in"); // külső → binance
    expect(r[1].whale?.direction).toBe("exchange-out"); // kraken → külső
  });

  it("API hiba esetén üres listát ad", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const c = new WhaleAlertCollector("tok", ["BTC"]);
    expect(await c.collect()).toEqual([]);
  });
});

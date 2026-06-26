import { describe, it, expect, vi, beforeEach } from "vitest";
import { BinanceBroker } from "@/lib/execution/binance-broker";

describe("BinanceBroker", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("hiányzó kulcsoknál a konstruktor dob", () => {
    expect(() => new BinanceBroker("", "")).toThrow(/API kulcs/);
  });

  it("elutasítja a kötelező stop-loss alatti order-t", async () => {
    const broker = new BinanceBroker("key", "secret");
    await expect(
      broker.execute({ side: "BUY", symbol: "BTC", amountUsd: 60, stopLossPct: 0.01 }, 60000),
    ).rejects.toThrow(/stop-loss/);
  });

  it("BUY: signed MARKET order-t küld és Trade-et ad vissza (mode=live)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        orderId: 12345,
        executedQty: "0.001",
        cummulativeQuoteQty: "60.0",
        status: "FILLED",
        fills: [{ price: "60000", qty: "0.001", commission: "0.06", commissionAsset: "USDT" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const broker = new BinanceBroker("mykey", "mysecret");
    const trade = await broker.execute(
      { side: "BUY", symbol: "BTC", amountUsd: 60, stopLossPct: 0.05 },
      60000,
    );

    expect(trade.mode).toBe("live");
    expect(trade.symbol).toBe("BTC");
    expect(trade.qty).toBeCloseTo(0.001, 6);
    expect(trade.price).toBeCloseTo(60000, 2); // 60.0 / 0.001
    expect(trade.amountUsd).toBeCloseTo(60, 4);
    expect(trade.feeUsd).toBeCloseTo(0.06, 4);

    // Aláírt kérés: a market order az első hívás
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v3/order");
    expect(url).toContain("symbol=BTCUSDT");
    expect(url).toContain("quoteOrderQty=60.00");
    expect(url).toContain("signature=");
    expect(opts.headers["X-MBX-APIKEY"]).toBe("mykey");

    // BUY után megy a védő stop-loss order is (2. hívás)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls[1][0]).toContain("STOP_LOSS_LIMIT");
  });

  it("Binance hibakódnál dob (a hívó HOLD-ra eshet)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ code: -2010, msg: "Account has insufficient balance" }),
      }),
    );
    const broker = new BinanceBroker("k", "s");
    await expect(
      broker.execute({ side: "BUY", symbol: "BTC", amountUsd: 60, stopLossPct: 0.05 }, 60000),
    ).rejects.toThrow(/Binance 400/);
  });
});

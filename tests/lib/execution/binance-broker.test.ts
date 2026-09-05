import { describe, it, expect, vi, beforeEach } from "vitest";
import { BinanceBroker } from "@/lib/execution/binance-broker";
import type { SymbolFilters } from "@/lib/execution/exchange-rules";

const NOW = Date.now();

/** BTCUSDT szűrők. Élesben ezt az exchangeInfo tölti fel (T24). */
const btcFilters: SymbolFilters = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  status: "TRADING",
  tickSize: "0.01",
  minPrice: "0.01",
  maxPrice: "1000000",
  stepSize: "0.00001",
  minQty: "0.00001",
  maxQty: "9000",
  marketStepSize: null,
  marketMinQty: null,
  marketMaxQty: null,
  minNotional: "5",
  applyMinToMarket: true,
  fetchedAt: NOW,
};

function brokerWithFilters(filters: Record<string, SymbolFilters> = { BTCUSDT: btcFilters }) {
  const b = new BinanceBroker("mykey", "mysecret");
  b.filters = filters;
  return b;
}

describe("BinanceBroker", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("hiányzó kulcsoknál a konstruktor dob", () => {
    expect(() => new BinanceBroker("", "")).toThrow(/API kulcs/);
  });

  it("T24: szűrőkészlet NÉLKÜL nem küld ordert (ismeretlen szabályok)", async () => {
    const broker = new BinanceBroker("key", "secret");
    await expect(
      broker.execute({ side: "BUY", symbol: "BTC", amountUsd: 60, stopLossPct: 0.05 }, 60000),
    ).rejects.toThrow(/unknown_symbol|szabályok/);
  });

  it("T24: a kitalált „min 5% stop” dobás MEGSZŰNT — 1%-os stop is átmegy a brokeren", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        orderId: 1,
        executedQty: "0.001",
        cummulativeQuoteQty: "60.0",
        status: "FILLED",
        fills: [{ price: "60000", qty: "0.001", commission: "0.06", commissionAsset: "USDT" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const trade = await brokerWithFilters().execute(
      { side: "BUY", symbol: "BTC", amountUsd: 60, stopLossPct: 0.01 },
      60000,
    );
    expect(trade.mode).toBe("live");
  });

  it("T24: a minimum notional alatti order ELUTASÍTÁSRA kerül, nem megy ki a tőzsdére", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      brokerWithFilters().execute({ side: "BUY", symbol: "BTC", amountUsd: 2, stopLossPct: 0.05 }, 60000),
    ).rejects.toThrow(/below_min_notional/);
    expect(fetchMock).not.toHaveBeenCalled();
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

    const trade = await brokerWithFilters().execute(
      { side: "BUY", symbol: "BTC", amountUsd: 60, stopLossPct: 0.05 },
      60000,
    );

    expect(trade.mode).toBe("live");
    expect(trade.symbol).toBe("BTC");
    expect(trade.qty).toBeCloseTo(0.001, 6);
    expect(trade.price).toBeCloseTo(60000, 2);
    expect(trade.amountUsd).toBeCloseTo(60, 4);
    expect(trade.feeUsd).toBeCloseTo(0.06, 4);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v3/order");
    expect(url).toContain("symbol=BTCUSDT");
    // A kerekítés UTÁNI notional megy ki, nem a nyers toFixed(2).
    expect(url).toContain("quoteOrderQty=");
    expect(url).toContain("signature=");
    expect(opts.headers["X-MBX-APIKEY"]).toBe("mykey");

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls[1][0]).toContain("STOP_LOSS_LIMIT");
  });

  it("T24: a védőorder ára a tickSize-ra kerekül, és a limit a stop ALATT van", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        orderId: 2,
        executedQty: "0.001",
        cummulativeQuoteQty: "60.123456",
        status: "FILLED",
        fills: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await brokerWithFilters().execute({ side: "BUY", symbol: "BTC", amountUsd: 60, stopLossPct: 0.05 }, 60000);

    const protectUrl: string = fetchMock.mock.calls[1][0];
    const stop = Number(new URL(protectUrl).searchParams.get("stopPrice"));
    const limit = Number(new URL(protectUrl).searchParams.get("price"));
    // Két tizedes (tickSize 0.01) és limit < stop.
    expect(Number.isInteger(Math.round(stop * 100))).toBe(true);
    expect(limit).toBeLessThan(stop);
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
    await expect(
      brokerWithFilters().execute({ side: "BUY", symbol: "BTC", amountUsd: 60, stopLossPct: 0.05 }, 60000),
    ).rejects.toThrow(/Binance 400/);
  });

  it("ELAVULT szűrőkészlettel nem küld ordert", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stale = { ...btcFilters, fetchedAt: NOW - 48 * 3600_000 };
    await expect(
      brokerWithFilters({ BTCUSDT: stale }).execute(
        { side: "BUY", symbol: "BTC", amountUsd: 60, stopLossPct: 0.05 },
        60000,
      ),
    ).rejects.toThrow(/stale_filters/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  mapStatus,
  mapFills,
  interpretOrder,
  unknownFromError,
  feeOf,
  totalFilledQty,
  averageFillPrice,
} from "@/lib/execution/binance-order-state";
import { BinanceExecutionBroker, type BinanceHttp } from "@/lib/execution/binance-broker";
import { EXECUTION_CONTRACT_VERSION, clientOrderId, type ExecutionIntent } from "@/lib/execution/contracts";
import type { SymbolFilters } from "@/lib/execution/exchange-rules";

const NOW = 1_700_000_000_000;

const intent = (over: Partial<ExecutionIntent> = {}): ExecutionIntent => ({
  intentId: "i-1",
  portfolioId: "pf",
  mode: "live",
  strategyVersion: "v2",
  origin: "ai",
  expiresAt: NOW + 60_000,
  contractVersion: EXECUTION_CONTRACT_VERSION,
  referencePrice: "60000",
  order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "60" },
  ...over,
});

const filters: SymbolFilters = {
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

describe("mapStatus — az ismeretlen státusz NEM siker", () => {
  it("a Binance státuszokat a szerződésre képezi", () => {
    expect(mapStatus("NEW")).toBe("pending");
    expect(mapStatus("PARTIALLY_FILLED")).toBe("partially_filled");
    expect(mapStatus("FILLED")).toBe("filled");
    expect(mapStatus("CANCELED")).toBe("canceled");
    expect(mapStatus("REJECTED")).toBe("rejected");
    expect(mapStatus("EXPIRED")).toBe("expired");
  });

  it("ismeretlen vagy hiányzó státusz → unknown", () => {
    expect(mapStatus("VALAMI_UJ")).toBe("unknown");
    expect(mapStatus(undefined)).toBe("unknown");
  });
});

describe("mapFills — a díj a SAJÁT eszközében marad", () => {
  it("quote-díj (USDT) egyszerűen átmegy", () => {
    const r = mapFills(
      {
        orderId: 1,
        status: "FILLED",
        fills: [{ tradeId: 11, price: "60000", qty: "0.001", quoteQty: "60", commission: "0.06", commissionAsset: "USDT" }],
      },
      intent(),
    );
    expect(r.fills[0].feeAsset).toBe("USDT");
    expect(r.fills[0].feeAmount).toBe("0.06");
    expect(r.pendingFeeValuations).toHaveLength(0);
  });

  it("BNB-díj FÜGGŐ értékelésű, de a díj NEM vész el és nem lesz nulla", () => {
    const r = mapFills(
      {
        orderId: 1,
        status: "FILLED",
        fills: [{ tradeId: 11, price: "60000", qty: "0.001", quoteQty: "60", commission: "0.0001", commissionAsset: "BNB" }],
      },
      intent(),
    );
    expect(r.fills[0].feeAsset).toBe("BNB");
    expect(r.fills[0].feeAmount).toBe("0.0001");
    expect(r.pendingFeeValuations).toEqual([{ fillId: r.fills[0].fillId, asset: "BNB", amount: "0.0001" }]);
  });

  it("base-eszközű díj ismert, nem függő", () => {
    const f = feeOf({ commission: "0.000001", commissionAsset: "BTC" }, "USDT", "BTC");
    expect(f.valuationPending).toBe(false);
  });

  it("a fill-kulcs a mód, az orderId és a tradeId hármasából jön → nincs dupla könyvelés", () => {
    const payload = {
      orderId: 42,
      status: "FILLED",
      fills: [
        { tradeId: 7, price: "60000", qty: "0.001", quoteQty: "60", commission: "0", commissionAsset: "USDT" },
        { tradeId: 7, price: "60000", qty: "0.001", quoteQty: "60", commission: "0", commissionAsset: "USDT" },
      ],
    };
    const r = mapFills(payload, intent());
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0].fillId).toBe("live:42:7");
  });

  it("nulla mennyiségű sor NEM fill", () => {
    const r = mapFills(
      { orderId: 1, status: "FILLED", fills: [{ tradeId: 1, price: "60000", qty: "0", quoteQty: "0" }] },
      intent(),
    );
    expect(r.fills).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("zero_qty");
  });

  it("azonosító nélküli sor kimarad, és ez látszik", () => {
    const r = mapFills({ status: "FILLED", fills: [{ price: "1", qty: "1" }] }, intent());
    expect(r.fills).toHaveLength(0);
    expect(r.skipped[0].reason).toBe("missing_ids");
  });

  it("több részteljesülés összegzése", () => {
    const r = mapFills(
      {
        orderId: 5,
        status: "PARTIALLY_FILLED",
        fills: [
          { tradeId: 1, price: "60000", qty: "0.0005", quoteQty: "30", commission: "0.03", commissionAsset: "USDT" },
          { tradeId: 2, price: "60100", qty: "0.0005", quoteQty: "30.05", commission: "0.03", commissionAsset: "USDT" },
        ],
      },
      intent(),
    );
    expect(r.fills).toHaveLength(2);
    expect(totalFilledQty(r.fills)).toBe("0.001");
    expect(Number(averageFillPrice(r.fills))).toBeCloseTo(60050, 6);
  });

  it("nulla mennyiségre nincs kitalált átlagár", () => {
    expect(averageFillPrice([])).toBeNull();
  });
});

describe("interpretOrder — a nulla fill NEM hamis teljes siker", () => {
  it("FILLED státusz teljesüléssel valóban siker", () => {
    const r = interpretOrder(
      { orderId: 1, status: "FILLED", fills: [{ tradeId: 1, price: "60000", qty: "0.001", quoteQty: "60" }] },
      intent(),
    );
    expect(r.state).toBe("filled");
    expect(r.open).toBe(false);
  });

  it("FILLED státusz NULLA teljesüléssel → unknown, egyeztetés kell", () => {
    const r = interpretOrder({ orderId: 1, status: "FILLED", fills: [] }, intent());
    expect(r.state).toBe("unknown");
    expect(r.open).toBe(true);
    expect(r.message).toMatch(/egyeztetés/i);
  });

  it("PARTIALLY_FILLED nyitva marad", () => {
    const r = interpretOrder(
      { orderId: 1, status: "PARTIALLY_FILLED", fills: [{ tradeId: 1, price: "60000", qty: "0.0005", quoteQty: "30" }] },
      intent(),
    );
    expect(r.state).toBe("partially_filled");
    expect(r.open).toBe(true);
    expect(r.fills).toHaveLength(1);
  });

  it("timeout → ISMERETLEN állapot, nem elutasítás", () => {
    const r = unknownFromError(new Error("ETIMEDOUT"));
    expect(r.state).toBe("unknown");
    expect(r.open).toBe(true);
    expect(r.message).toMatch(/ÚJ order NEM küldhető/);
  });
});

describe("BinanceExecutionBroker — idempotens beküldés (T25)", () => {
  const http = (over: Partial<BinanceHttp> = {}): BinanceHttp => ({
    signedPost: vi.fn(async () => ({
      orderId: 1,
      status: "FILLED",
      fills: [{ tradeId: 1, price: "60000", qty: "0.001", quoteQty: "60", commission: "0.06", commissionAsset: "USDT" }],
    })),
    signedGet: vi.fn(async () => ({ orderId: 1, status: "FILLED", fills: [] })),
    ...over,
  });

  const broker = (h: BinanceHttp) =>
    new BinanceExecutionBroker({ http: h, filters: { BTCUSDT: filters }, now: () => NOW });

  it("STABIL client order ID megy ki az intentId-ból", async () => {
    const h = http();
    const r = await broker(h).submit(intent());
    expect(r.clientOrderId).toBe(clientOrderId("i-1"));
    const params = (h.signedPost as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(params.newClientOrderId).toBe(clientOrderId("i-1"));
  });

  it("timeout után LEKÉRDEZÜNK, nem küldünk új azonosítójú ordert", async () => {
    const signedPost = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    const h = http({ signedPost });
    const r = await broker(h).submit(intent());
    expect(r.state).toBe("unknown");
    expect(signedPost).toHaveBeenCalledTimes(1);
    expect(r.fills).toHaveLength(0);
  });

  it("„már létező azonosító” hibára a MEGLÉVŐ ordert kérdezzük le", async () => {
    const signedPost = vi.fn(async () => {
      throw new Error("Binance -2010: Duplicate order sent");
    });
    const signedGet = vi.fn(async () => ({
      orderId: 9,
      status: "FILLED",
      fills: [{ tradeId: 3, price: "60000", qty: "0.001", quoteQty: "60" }],
    }));
    const r = await broker(http({ signedPost, signedGet })).submit(intent());
    expect(signedGet).toHaveBeenCalled();
    expect(r.state).toBe("filled");
    expect(r.fills[0].exchangeOrderId).toBe("9");
  });

  it("lejárt intentre nem megy ki order", async () => {
    const h = http();
    const r = await broker(h).submit(intent({ expiresAt: NOW - 1 }));
    expect(r.state).toBe("rejected");
    expect(h.signedPost).not.toHaveBeenCalled();
  });

  it("szűrő nélkül nem megy ki order", async () => {
    const h = http();
    const b = new BinanceExecutionBroker({ http: h, filters: {}, now: () => NOW });
    const r = await b.submit(intent());
    expect(r.state).toBe("rejected");
    expect(h.signedPost).not.toHaveBeenCalled();
  });

  it("a minimum notional alatti intent elutasításra kerül a tőzsde ELŐTT", async () => {
    const h = http();
    const r = await broker(h).submit(intent({ order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "2" } }));
    expect(r.state).toBe("rejected");
    expect(r.error?.code).toBe("below_min_notional");
    expect(h.signedPost).not.toHaveBeenCalled();
  });

  it("részleges teljesülés részlegesként látszik", async () => {
    const h = http({
      signedPost: vi.fn(async () => ({
        orderId: 3,
        status: "PARTIALLY_FILLED",
        fills: [{ tradeId: 1, price: "60000", qty: "0.0004", quoteQty: "24" }],
      })),
    });
    const r = await broker(h).submit(intent());
    expect(r.state).toBe("partially_filled");
    expect(r.fills).toHaveLength(1);
  });

  it("„nem létező order” lekérdezésre elutasítás (nem teljesült)", async () => {
    const h = http({
      signedGet: vi.fn(async () => {
        throw new Error("Binance -2013: Order does not exist");
      }),
    });
    const r = await broker(h).lookup(intent());
    expect(r.state).toBe("rejected");
    expect(r.error?.code).toBe("order_not_found");
  });

  it("a függő díjértékelések gyűjtve vannak", async () => {
    const h = http({
      signedPost: vi.fn(async () => ({
        orderId: 4,
        status: "FILLED",
        fills: [{ tradeId: 1, price: "60000", qty: "0.001", quoteQty: "60", commission: "0.0002", commissionAsset: "BNB" }],
      })),
    });
    const b = broker(h);
    await b.submit(intent());
    expect(b.pendingFeeValuations).toEqual([{ fillId: "live:4:1", asset: "BNB", amount: "0.0002" }]);
  });

  it("ugyanaz az intent kétszer beküldve UGYANAZT a fill-kulcsot adja (nincs dupla könyvelés)", async () => {
    const h = http();
    const b = broker(h);
    const a = await b.submit(intent());
    const c = await b.submit(intent());
    expect(c.fills[0].fillId).toBe(a.fills[0].fillId);
  });
});

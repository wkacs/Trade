import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { resetSchema, truncateAll, testSql } from "./db-helpers";
import { recordIntent, persistFill, loadLedgerState, seedLedger, listUnsettledIntents } from "@/lib/execution/order-store";
import { executeIntent, type ExecuteIntentDeps } from "@/lib/engine/execute-intent";
import { BinanceExecutionBroker, type BinanceHttp } from "@/lib/execution/binance-broker";
import { EXECUTION_CONTRACT_VERSION, clientOrderId, type ExecutionIntent } from "@/lib/execution/contracts";
import type { SymbolFilters } from "@/lib/execution/exchange-rules";
import { applyFill, emptyLedger } from "@/lib/portfolio/ledger";
import { DEFAULT_ORDER_RISK_PARAMS } from "@/lib/risk/risk-manager";

/**
 * T25 — újraindulás és retry valódi PostgreSQL ellen.
 *
 * Amit bizonyít:
 *  - az újraindulás NEM küld új azonosítójú duplikátumot (a client order ID stabil);
 *  - ugyanaz a fill kétszer beolvasva egyszer könyvelődik;
 *  - a timeout utáni lekérdezés a MEGLÉVŐ megbízást találja meg;
 *  - az ismeretlen állapotú intent egyeztetésre vár, nem tűnik el.
 */
const SCOPE = { portfolioId: "pf", mode: "live" as const };
const NOW = 1_700_000_000_000;

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

const intent = (over: Partial<ExecutionIntent> = {}): ExecutionIntent => ({
  intentId: over.intentId ?? "i-1",
  portfolioId: SCOPE.portfolioId,
  mode: SCOPE.mode,
  strategyVersion: "v2",
  origin: "ai",
  expiresAt: NOW + 60_000,
  contractVersion: EXECUTION_CONTRACT_VERSION,
  referencePrice: "60000",
  order: over.order ?? { side: "BUY", symbol: "BTC", maxQuoteSpend: "60" },
  ...over,
});

const filledPayload = (orderId: number, tradeId: number) => ({
  orderId,
  status: "FILLED",
  fills: [{ tradeId, price: "60000", qty: "0.001", quoteQty: "60", commission: "0.06", commissionAsset: "USDT" }],
});

describe("order recovery — valódi PostgreSQL", () => {
  beforeAll(async () => {
    await resetSchema();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    await seedLedger(SCOPE, "1000", []);
  });

  it("a beküldött intent naplózódik, és nyitottként listázódik", async () => {
    const i = intent();
    await recordIntent(i, { exchangeOrderId: null, clientOrderId: clientOrderId(i.intentId), state: "pending", fills: [] });
    const pending = await listUnsettledIntents(SCOPE);
    expect(pending.map((p) => p.intentId)).toContain("i-1");
    expect(pending[0].clientOrderId).toBe(clientOrderId("i-1"));
  });

  it("timeout után a LEKÉRDEZÉS találja meg a megbízást, nem új order megy ki", async () => {
    const signedPost = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    const signedGet = vi.fn(async () => filledPayload(77, 5));
    const http: BinanceHttp = { signedPost, signedGet };
    const broker = new BinanceExecutionBroker({ http, filters: { BTCUSDT: filters }, now: () => NOW });

    const i = intent();
    const first = await broker.submit(i);
    expect(first.state).toBe("unknown");
    await recordIntent(i, first);

    // Újraindulás: a nyitott intentet egyeztetjük, NEM küldünk újat.
    const pending = await listUnsettledIntents(SCOPE);
    expect(pending).toHaveLength(1);
    const recovered = await broker.lookup(i);
    expect(signedPost).toHaveBeenCalledTimes(1);
    expect(recovered.state).toBe("filled");
    expect(recovered.fills[0].exchangeOrderId).toBe("77");
  });

  it("a lekérdezett fill EGYSZER könyvelődik, ismételt egyeztetés után is", async () => {
    const i = intent();
    const broker = new BinanceExecutionBroker({
      http: { signedPost: vi.fn(async () => filledPayload(88, 9)), signedGet: vi.fn(async () => filledPayload(88, 9)) },
      filters: { BTCUSDT: filters },
      now: () => NOW,
    });
    const receipt = await broker.submit(i);
    const fill = receipt.fills[0];
    const deltas = applyFill(emptyLedger(SCOPE.portfolioId, SCOPE.mode, "1000"), fill).deltas!;

    expect((await persistFill(i, fill, deltas)).applied).toBe(true);
    // Az egyeztetés ugyanazt a fillt hozza vissza — másodszor NEM mozdul egyenleg.
    const again = await broker.lookup(i);
    expect((await persistFill(i, again.fills[0], deltas)).applied).toBe(false);

    const rows = (await testSql()`SELECT count(*)::int AS c FROM execution_fills`) as { c: number }[];
    expect(rows[0].c).toBe(1);
    const ledger = await loadLedgerState(SCOPE);
    expect(ledger.cash.USDT).toBe("939.94");
  });

  it("az újraindulás UGYANAZT a client order ID-t használja (nincs duplikátum)", async () => {
    const posts: Record<string, string>[] = [];
    const http: BinanceHttp = {
      signedPost: vi.fn(async (_p: string, params: Record<string, string>) => {
        posts.push(params);
        return filledPayload(99, 1);
      }),
      signedGet: vi.fn(async () => filledPayload(99, 1)),
    };
    const broker = new BinanceExecutionBroker({ http, filters: { BTCUSDT: filters }, now: () => NOW });
    const i = intent();
    await broker.submit(i);
    // „Újraindulás": új broker-példány, UGYANAZ az intent.
    const broker2 = new BinanceExecutionBroker({ http, filters: { BTCUSDT: filters }, now: () => NOW });
    await broker2.submit(i);
    expect(posts).toHaveLength(2);
    expect(posts[0].newClientOrderId).toBe(posts[1].newClientOrderId);
  });

  it("a végrehajtási út a lekérdezett fillt is a KÖZÖS könyvelőn viszi át", async () => {
    let ledger = await loadLedgerState(SCOPE);
    const i = intent();
    const broker = new BinanceExecutionBroker({
      http: { signedPost: vi.fn(async () => filledPayload(101, 2)), signedGet: vi.fn(async () => filledPayload(101, 2)) },
      filters: { BTCUSDT: filters },
      now: () => NOW,
    });

    const deps: ExecuteIntentDeps = {
      portfolioId: SCOPE.portfolioId,
      mode: SCOPE.mode,
      strategyVersion: "v2",
      broker,
      getLedger: () => ledger,
      getRiskContext: () => ({
        ledger,
        prices: { BTC: "60000" },
        reservedQuoteBySymbol: {},
        reservedQuoteTotal: "0",
        dailyLossLatched: false,
        dayBaselineMissing: false,
        allowedSymbols: ["BTC"],
        quoteAsset: "USDT",
      }),
      riskParams: DEFAULT_ORDER_RISK_PARAMS,
      now: () => NOW,
      newIntentId: () => i.intentId,
      persist: async (pIntent, fill, deltas) => {
        await persistFill(pIntent, fill, deltas);
      },
      recordIntent: async (pIntent, receipt) => {
        await recordIntent(pIntent, receipt);
      },
    };

    const outcome = await executeIntent(
      { side: "BUY", symbol: "BTC", desiredQuote: "60", origin: "ai", referencePrice: "60000" },
      deps,
    );
    expect(outcome.status).toBe("executed");
    if (outcome.status === "executed") ledger = outcome.ledger;

    const fresh = await loadLedgerState(SCOPE);
    expect(Number(fresh.positions.BTC.qty)).toBeCloseTo(0.001, 9);
  });
});

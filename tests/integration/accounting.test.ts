import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { resetSchema, truncateAll, testSql } from "./db-helpers";
import {
  loadLedgerState,
  hasLedgerState,
  loadReservations,
  reserveBudget,
  releaseReservation,
  persistFill,
  persistStopPrice,
  seedLedger,
  recordIntent,
  listUnsettledIntents,
  PersistenceError,
} from "@/lib/execution/order-store";
import { applyFill, emptyLedger } from "@/lib/portfolio/ledger";
import { EXECUTION_CONTRACT_VERSION, type ExecutionIntent, type Fill } from "@/lib/execution/contracts";

/**
 * T09 — egy tranzakciós perzisztencia-út, valódi PostgreSQL ellen.
 *
 * Amit bizonyít:
 *  - fill + cash + pozíció + foglalás EGYÜTT commitol vagy EGYÜTT bukik;
 *  - a duplikált fill nem változtat egyenleget;
 *  - két párhuzamos BUY nem lépi át a foglalt keretet;
 *  - a friss DB-visszaolvasás egyezik a reducer állapotával;
 *  - a DB-hiba STRUKTURÁLT hibát ad, nem néma sikert.
 */
const SCOPE = { portfolioId: "pf", mode: "paper" as const };
const NOW = 1_700_000_000_000;

function intent(over: Partial<ExecutionIntent> & { order: ExecutionIntent["order"] }): ExecutionIntent {
  return {
    intentId: over.intentId ?? "i-1",
    portfolioId: SCOPE.portfolioId,
    mode: SCOPE.mode,
    strategyVersion: "v2-test",
    origin: over.origin ?? "ai",
    expiresAt: over.expiresAt ?? NOW + 60_000,
    contractVersion: EXECUTION_CONTRACT_VERSION,
    referencePrice: over.referencePrice ?? "60000",
    order: over.order,
  };
}

function fill(over: Partial<Fill> & Pick<Fill, "side" | "filledBaseQty" | "grossQuoteAmount" | "fillPrice">): Fill {
  const orderId = over.exchangeOrderId ?? "o-1";
  const tradeId = over.exchangeTradeId ?? "t-1";
  return {
    fillId: over.fillId ?? `paper:${orderId}:${tradeId}`,
    intentId: over.intentId ?? "i-1",
    portfolioId: SCOPE.portfolioId,
    mode: SCOPE.mode,
    symbol: over.symbol ?? "BTC",
    side: over.side,
    exchangeOrderId: orderId,
    exchangeTradeId: tradeId,
    filledBaseQty: over.filledBaseQty,
    grossQuoteAmount: over.grossQuoteAmount,
    fillPrice: over.fillPrice,
    feeAmount: over.feeAmount ?? "0",
    feeAsset: over.feeAsset ?? "USDT",
    executedAt: over.executedAt ?? NOW,
  };
}

describe("tranzakciós perzisztencia — valódi PostgreSQL", () => {
  beforeAll(async () => {
    await resetSchema();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    await seedLedger(SCOPE, "100", []);
  });

  it("a nyitóállapot betölthető és egyezik a reducer üres állapotával", async () => {
    expect(await hasLedgerState(SCOPE)).toBe(true);
    const state = await loadLedgerState(SCOPE);
    expect(state.cash.USDT).toBe("100");
    expect(Object.keys(state.positions)).toHaveLength(0);
  });

  it("fill + cash + pozíció EGYÜTT commitol, és a visszaolvasás egyezik a reducerrel", async () => {
    const f = fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.06" });
    const expected = applyFill(emptyLedger(SCOPE.portfolioId, SCOPE.mode, "100"), f, { stopPrice: "57000" });
    expect(expected.applied).toBe(true);

    const outcome = await persistFill(intent({ order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "60.06" } }), f, expected.deltas!);
    expect(outcome.applied).toBe(true);

    const fresh = await loadLedgerState(SCOPE);
    expect(fresh.cash.USDT).toBe(expected.state.cash.USDT);
    expect(fresh.positions.BTC.qty).toBe(expected.state.positions.BTC.qty);
    expect(fresh.positions.BTC.costBasisQuote).toBe(expected.state.positions.BTC.costBasisQuote);
    expect(fresh.positions.BTC.stopPrice).toBe("57000");
  });

  it("a duplikált fill nem változtat egyenleget", async () => {
    const f = fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.06" });
    const deltas = applyFill(emptyLedger(SCOPE.portfolioId, SCOPE.mode, "100"), f).deltas!;
    const i = intent({ order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "60.06" } });

    expect((await persistFill(i, f, deltas)).applied).toBe(true);
    const second = await persistFill(i, f, deltas);
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("duplicate_fill");

    const fresh = await loadLedgerState(SCOPE);
    expect(fresh.cash.USDT).toBe("39.94");
    const rows = (await testSql()`SELECT count(*)::int AS c FROM execution_fills`) as { c: number }[];
    expect(rows[0].c).toBe(1);
  });

  it("fedezethiánynál a TELJES művelet visszagördül (a fill sem marad bent)", async () => {
    const f = fill({
      side: "BUY",
      filledBaseQty: "0.01",
      grossQuoteAmount: "600",
      fillPrice: "60000",
      feeAmount: "0.6",
      exchangeOrderId: "o-big",
    });
    const deltas = {
      cash: [{ asset: "USDT", delta: "-600.6" }],
      position: { symbol: "BTC", qtyDelta: "0.01", costDelta: "600.6", stopPrice: null },
      reservation: null,
    };
    await expect(
      persistFill(intent({ order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "600.6" } }), f, deltas),
    ).rejects.toBeInstanceOf(PersistenceError);

    const fresh = await loadLedgerState(SCOPE);
    expect(fresh.cash.USDT).toBe("100");
    const rows = (await testSql()`SELECT count(*)::int AS c FROM execution_fills`) as { c: number }[];
    expect(rows[0].c).toBe(0);
  });

  it("két párhuzamos BUY nem lépi át a foglalt keretet", async () => {
    const a = intent({ intentId: "i-a", order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "80" } });
    const b = intent({ intentId: "i-b", order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "80" } });
    const [ra, rb] = await Promise.all([reserveBudget(a, "80", "100"), reserveBudget(b, "80", "100")]);
    // A kettő együtt 160 > 100 fedezet → csak az egyik mehet át.
    expect([ra, rb].filter(Boolean)).toHaveLength(1);

    const snapshot = await loadReservations(SCOPE);
    expect(Number(snapshot.total)).toBeLessThanOrEqual(100);
  });

  it("a foglalás idempotens ugyanarra az intentre", async () => {
    const i = intent({ intentId: "i-same", order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "10" } });
    expect(await reserveBudget(i, "10", "100")).toBe(true);
    expect(await reserveBudget(i, "10", "100")).toBe(true);
    const rows = (await testSql()`SELECT count(*)::int AS c FROM budget_reservations`) as { c: number }[];
    expect(rows[0].c).toBe(1);
  });

  it("az elengedett foglalás felszabadítja a keretet", async () => {
    const i = intent({ intentId: "i-rel", order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "90" } });
    expect(await reserveBudget(i, "90", "100")).toBe(true);
    await releaseReservation("i-rel");
    const snapshot = await loadReservations(SCOPE);
    expect(snapshot.total).toBe("0");
    const j = intent({ intentId: "i-rel2", order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "90" } });
    expect(await reserveBudget(j, "90", "100")).toBe(true);
  });

  it("a fill elszámolja a foglalást", async () => {
    const i = intent({ intentId: "i-c", order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "60.06" } });
    await reserveBudget(i, "60.06", "100");
    const f = fill({
      side: "BUY",
      filledBaseQty: "0.001",
      grossQuoteAmount: "60",
      fillPrice: "60000",
      feeAmount: "0.06",
      intentId: "i-c",
      exchangeOrderId: "o-c",
    });
    const deltas = applyFill(emptyLedger(SCOPE.portfolioId, SCOPE.mode, "100"), f).deltas!;
    await persistFill(i, f, { ...deltas, reservation: { intentId: "i-c", consumeQuote: "60.06" } });
    const rows = (await testSql()`SELECT state FROM budget_reservations WHERE intent_id = 'i-c'`) as { state: string }[];
    expect(rows[0].state).toBe("consumed");
  });

  it("a stop csak FELFELÉ írható a v2 ledgerben", async () => {
    const f = fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.06" });
    const deltas = applyFill(emptyLedger(SCOPE.portfolioId, SCOPE.mode, "100"), f, { stopPrice: "57000" }).deltas!;
    await persistFill(intent({ order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "60.06" } }), f, deltas);

    await persistStopPrice(SCOPE, "BTC", "58000");
    expect((await loadLedgerState(SCOPE)).positions.BTC.stopPrice).toBe("58000");
    await persistStopPrice(SCOPE, "BTC", "50000");
    expect((await loadLedgerState(SCOPE)).positions.BTC.stopPrice).toBe("58000");
  });

  it("az intent-napló egyedi és frissíthető, a nyitott intentek listázhatók", async () => {
    const i = intent({ intentId: "i-log", order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "10" } });
    await recordIntent(i, { exchangeOrderId: null, clientOrderId: "zct-i-log", state: "pending", fills: [] });
    await recordIntent(i, { exchangeOrderId: "x-1", clientOrderId: "zct-i-log", state: "unknown", fills: [] });
    const rows = (await testSql()`SELECT count(*)::int AS c FROM execution_intents`) as { c: number }[];
    expect(rows[0].c).toBe(1);

    const pending = await listUnsettledIntents(SCOPE);
    expect(pending.map((p) => p.intentId)).toContain("i-log");
    expect(pending[0].state).toBe("unknown");
  });

  it("a paper és a live számla nem oszt könyvelési sort", async () => {
    await seedLedger({ portfolioId: "pf", mode: "live" }, "500", []);
    const paper = await loadLedgerState(SCOPE);
    const live = await loadLedgerState({ portfolioId: "pf", mode: "live" });
    expect(paper.cash.USDT).toBe("100");
    expect(live.cash.USDT).toBe("500");
  });
});

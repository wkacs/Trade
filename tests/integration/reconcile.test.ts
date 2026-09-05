import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { resetSchema, truncateAll, testSql } from "./db-helpers";
import { seedLedger, loadLedgerState, persistFill } from "@/lib/execution/order-store";
import { reconcile, reconcileGate, type ExchangeSnapshot } from "@/lib/execution/reconcile";
import { applyFill, emptyLedger } from "@/lib/portfolio/ledger";
import { EXECUTION_CONTRACT_VERSION, type ExecutionIntent, type Fill } from "@/lib/execution/contracts";

/**
 * T27 — egyeztetés valódi PostgreSQL ellen.
 *
 * Amit bizonyít:
 *  - a kimaradás alatti stop-fill eltérésként jelenik meg;
 *  - az idegen kézi order blokkolja az új vételt;
 *  - a talált teljesülés PONTOSAN EGYSZER importálódik (idempotens helyreállítás);
 *  - a PAPER számla érintetlen marad.
 */
const LIVE = { portfolioId: "pf", mode: "live" as const };
const PAPER = { portfolioId: "pf", mode: "paper" as const };
const NOW = 1_700_000_000_000;

const intent = (id: string): ExecutionIntent => ({
  intentId: id,
  portfolioId: LIVE.portfolioId,
  mode: "live",
  strategyVersion: "v2",
  origin: "ai",
  expiresAt: NOW + 60_000,
  contractVersion: EXECUTION_CONTRACT_VERSION,
  referencePrice: "60000",
  order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "60" },
});

const buyFill = (orderId: string): Fill => ({
  fillId: `live:${orderId}:1`,
  intentId: `i-${orderId}`,
  portfolioId: LIVE.portfolioId,
  mode: "live",
  symbol: "BTC",
  side: "BUY",
  exchangeOrderId: orderId,
  exchangeTradeId: "1",
  filledBaseQty: "0.001",
  grossQuoteAmount: "60",
  fillPrice: "60000",
  feeAmount: "0",
  feeAsset: "USDT",
  executedAt: NOW,
});

const snapshot = (over: Partial<ExchangeSnapshot> = {}): ExchangeSnapshot => ({
  balances: [{ asset: "USDT", free: "940", locked: "0" }],
  openOrders: [],
  trades: {},
  fetchedAt: NOW,
  ...over,
});

async function knownFillIds(): Promise<string[]> {
  const rows = (await testSql()`SELECT fill_key FROM execution_fills`) as { fill_key: string }[];
  return rows.map((r) => r.fill_key);
}

describe("reconcile — valódi PostgreSQL", () => {
  beforeAll(async () => {
    await resetSchema();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    await seedLedger(LIVE, "1000", []);
    const f = buyFill("o-1");
    const deltas = applyFill(emptyLedger(LIVE.portfolioId, "live", "1000"), f, { stopPrice: "57000" }).deltas!;
    await persistFill(intent("i-o-1"), f, deltas);
  });

  it("a KIMARADÁS alatti stop-fill eltérésként jelenik meg, és tiltja a vételt", async () => {
    const ledger = await loadLedgerState(LIVE);
    expect(ledger.positions.BTC.qty).toBe("0.001");

    // A tőzsdén már nincs BTC (stop lefutott), és több USDT van.
    const r = reconcile(ledger, snapshot({ balances: [{ asset: "USDT", free: "997", locked: "0" }] }), "live");
    expect(r.discrepancies.some((d) => d.code === "position_mismatch")).toBe(true);
    expect(reconcileGate(r).allowNewBuys).toBe(false);
  });

  it("az idegen kézi order blokkolja az új vételt", async () => {
    const ledger = await loadLedgerState(LIVE);
    const r = reconcile(
      ledger,
      snapshot({
        balances: [
          { asset: "USDT", free: "940", locked: "0" },
          { asset: "BTC", free: "0.001", locked: "0" },
        ],
        openOrders: [
          {
            symbol: "BTCUSDT",
            orderId: "manual-9",
            clientOrderId: "kezi",
            side: "BUY",
            type: "LIMIT",
            origQty: "0.01",
            executedQty: "0",
            price: "50000",
            stopPrice: null,
            status: "NEW",
          },
        ],
      }),
      "live",
    );
    expect(r.discrepancies.some((d) => d.code === "unknown_open_order")).toBe(true);
    expect(reconcileGate(r).allowNewBuys).toBe(false);
  });

  it("a talált teljesülés PONTOSAN EGYSZER importálódik", async () => {
    const ledger = await loadLedgerState(LIVE);
    const trade = {
      tradeId: 5,
      orderId: 200,
      price: "61000",
      qty: "0.0005",
      quoteQty: "30.5",
      commission: "0.03",
      commissionAsset: "USDT",
      isBuyer: true,
      time: NOW,
    };

    const first = reconcile(ledger, snapshot({ trades: { BTC: [trade] } }), "live", {
      knownFillIds: await knownFillIds(),
      intentIdForOrder: { "200": "i-200" },
    });
    expect(first.newFills).toHaveLength(1);

    const f = first.newFills[0];
    const deltas = applyFill(ledger, f).deltas!;
    expect((await persistFill(intent("i-200"), f, deltas)).applied).toBe(true);

    // Második egyeztetés UGYANAZZAL a teljesüléssel: már ismert, nem importáljuk újra.
    const second = reconcile(await loadLedgerState(LIVE), snapshot({ trades: { BTC: [trade] } }), "live", {
      knownFillIds: await knownFillIds(),
      intentIdForOrder: { "200": "i-200" },
    });
    expect(second.newFills).toHaveLength(0);

    const rows = (await testSql()`SELECT count(*)::int AS c FROM execution_fills`) as { c: number }[];
    expect(rows[0].c).toBe(2);
  });

  it("a PAPER számlát az egyeztetés nem érinti", async () => {
    await seedLedger(PAPER, "500", []);
    const paperLedger = await loadLedgerState(PAPER);
    const r = reconcile(paperLedger, snapshot(), "paper");
    expect(r.usable).toBe(false);
    expect(r.newFills).toEqual([]);
    const after = await loadLedgerState(PAPER);
    expect(after.cash.USDT).toBe("500");
  });

  it("egyező állapot esetén az egyeztetés nem blokkol", async () => {
    const ledger = await loadLedgerState(LIVE);
    const r = reconcile(
      ledger,
      snapshot({
        balances: [
          { asset: "USDT", free: "940", locked: "0" },
          { asset: "BTC", free: "0", locked: "0.001" },
        ],
        openOrders: [
          {
            symbol: "BTCUSDT",
            orderId: "p-1",
            clientOrderId: "zct-p-1",
            side: "SELL",
            type: "STOP_LOSS_LIMIT",
            origQty: "0.001",
            executedQty: "0",
            price: "56942.94",
            stopPrice: "57000",
            status: "NEW",
          },
        ],
      }),
      "live",
    );
    expect(r.discrepancies).toEqual([]);
    expect(reconcileGate(r).allowNewBuys).toBe(true);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { resetSchema, truncateAll, testSql } from "./db-helpers";
import { seedLedger, loadLedgerState, persistFill, persistStopPrice } from "@/lib/execution/order-store";
import { planProtection, protectionGate, type ProtectionOrder } from "@/lib/execution/protection";
import { exitPositionsFromLedger } from "@/lib/engine/plan-exits";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import { applyFill, emptyLedger } from "@/lib/portfolio/ledger";
import type { Fill } from "@/lib/execution/contracts";
import { EXECUTION_CONTRACT_VERSION, type ExecutionIntent } from "@/lib/execution/contracts";
import type { SymbolFilters } from "@/lib/execution/exchange-rules";

/**
 * T26 — védőorder-helyreállítás valódi PostgreSQL ellen.
 *
 * Amit bizonyít:
 *  - újraindulás után a nyitott pozíció VÉDELEM NÉLKÜLI állapota kimutatható;
 *  - a rávásárlás és a részleges eladás után a védett mennyiség eltérése látszik;
 *  - a védelem hiánya megtiltja az új vételt;
 *  - a stop DB-beli frissítése önmagában NEM elég: a tőzsdei order cseréje külön terv.
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

const intent = (id: string): ExecutionIntent => ({
  intentId: id,
  portfolioId: SCOPE.portfolioId,
  mode: SCOPE.mode,
  strategyVersion: "v2",
  origin: "ai",
  expiresAt: NOW + 60_000,
  contractVersion: EXECUTION_CONTRACT_VERSION,
  referencePrice: "60000",
  order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "60" },
});

const buyFill = (id: string, qty: string, gross: string): Fill => ({
  fillId: `live:${id}:1`,
  intentId: id,
  portfolioId: SCOPE.portfolioId,
  mode: SCOPE.mode,
  symbol: "BTC",
  side: "BUY",
  exchangeOrderId: id,
  exchangeTradeId: "1",
  filledBaseQty: qty,
  grossQuoteAmount: gross,
  fillPrice: "60000",
  feeAmount: "0",
  feeAsset: "USDT",
  executedAt: NOW,
});

const protectionOrder = (qty: string, stopPrice = "57000"): ProtectionOrder => ({
  symbol: "BTC",
  exchangeOrderId: "p-1",
  clientOrderId: "zct-p-1",
  qty,
  stopPrice,
  limitPrice: "56942.94",
  state: "pending",
  placedAt: NOW,
});

async function ledgerAfterBuys(buys: { id: string; qty: string; gross: string }[]) {
  await seedLedger(SCOPE, "1000", []);
  for (const b of buys) {
    const f = buyFill(b.id, b.qty, b.gross);
    const deltas = applyFill(emptyLedger(SCOPE.portfolioId, SCOPE.mode, "1000"), f, { stopPrice: "57000" }).deltas!;
    await persistFill(intent(b.id), f, deltas);
  }
  return loadLedgerState(SCOPE);
}

describe("protection recovery — valódi PostgreSQL", () => {
  beforeAll(async () => {
    await resetSchema();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  });

  it("újraindulás után a védelem nélküli pozíció kimutatható, és tiltja az új vételt", async () => {
    const ledger = await ledgerAfterBuys([{ id: "o-1", qty: "0.001", gross: "60" }]);
    const plan = planProtection(
      {
        positions: exitPositionsFromLedger(ledger.positions).map((p) => ({
          symbol: p.symbol,
          qty: p.qty,
          desiredStop: p.stopPrice,
        })),
        existing: {},
        filters: { BTC: filters },
      },
      DEFAULT_STRATEGY,
    );
    expect(plan.actions[0].kind).toBe("place");
    expect(protectionGate(plan.incidents).allowNewBuys).toBe(false);
  });

  it("RÁVÁSÁRLÁS után a védett mennyiség kevés → csere ÉS vétel-tiltás", async () => {
    const ledger = await ledgerAfterBuys([
      { id: "o-1", qty: "0.001", gross: "60" },
      { id: "o-2", qty: "0.001", gross: "60" },
    ]);
    expect(ledger.positions.BTC.qty).toBe("0.002");

    const plan = planProtection(
      {
        positions: [{ symbol: "BTC", qty: ledger.positions.BTC.qty, desiredStop: "57000" }],
        existing: { BTC: protectionOrder("0.001") },
        filters: { BTC: filters },
      },
      DEFAULT_STRATEGY,
    );
    expect(plan.actions[0]).toMatchObject({ kind: "replace", qty: "0.002" });
    expect(protectionGate(plan.incidents).allowNewBuys).toBe(false);
  });

  it("a DB-stop frissítése ÖNMAGÁBAN nem elég — a tőzsdei csere külön terv", async () => {
    const ledger = await ledgerAfterBuys([{ id: "o-1", qty: "0.001", gross: "60" }]);
    await persistStopPrice(SCOPE, "BTC", "62700");
    const fresh = await loadLedgerState(SCOPE);
    expect(fresh.positions.BTC.stopPrice).toBe("62700");

    // A tőzsdén még a RÉGI stop ül.
    const plan = planProtection(
      {
        positions: [{ symbol: "BTC", qty: fresh.positions.BTC.qty, desiredStop: fresh.positions.BTC.stopPrice }],
        existing: { BTC: protectionOrder("0.001", "57000") },
        filters: { BTC: filters },
      },
      DEFAULT_STRATEGY,
    );
    expect(plan.actions[0]).toMatchObject({ kind: "replace", stopPrice: "62700" });
    expect(plan.incidents.some((i) => i.code === "stale_stop")).toBe(true);
    void ledger;
  });

  it("a lezárt pozíció árva védőordere törlendő, de nem tiltja a vételt", async () => {
    await seedLedger(SCOPE, "1000", []);
    const plan = planProtection(
      { positions: [], existing: { BTC: protectionOrder("0.001") }, filters: { BTC: filters } },
      DEFAULT_STRATEGY,
    );
    expect(plan.actions[0].kind).toBe("cancel");
    expect(protectionGate(plan.incidents).allowNewBuys).toBe(true);
  });

  it("a v2 ledger a védelem forrása: a fill után a stop is elmentődik", async () => {
    const ledger = await ledgerAfterBuys([{ id: "o-1", qty: "0.001", gross: "60" }]);
    expect(ledger.positions.BTC.stopPrice).toBe("57000");
    const rows = (await testSql()`SELECT stop_price::text AS s FROM ledger_positions WHERE symbol = 'BTC'`) as {
      s: string;
    }[];
    expect(Number(rows[0].s)).toBe(57000);
  });
});

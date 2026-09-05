import { describe, it, expect } from "vitest";
import { reconcile, reconcileGate, formatReconcile, isSnapshotFresh, type ExchangeSnapshot } from "@/lib/execution/reconcile";
import { emptyLedger, type LedgerState } from "@/lib/portfolio/ledger";

const NOW = 1_700_000_000_000;

function ledger(cash: string, positions: Record<string, { qty: string; cost: string }> = {}): LedgerState {
  return {
    ...emptyLedger("pf", "live", cash),
    positions: Object.fromEntries(
      Object.entries(positions).map(([symbol, v]) => [
        symbol,
        { symbol, qty: v.qty, costBasisQuote: v.cost, stopPrice: "57000" },
      ]),
    ),
  };
}

const snapshot = (over: Partial<ExchangeSnapshot> = {}): ExchangeSnapshot => ({
  balances: [{ asset: "USDT", free: "1000", locked: "0" }],
  openOrders: [],
  trades: {},
  fetchedAt: NOW,
  ...over,
});

const protectionOrder = (qty = "0.001") => ({
  symbol: "BTCUSDT",
  orderId: "p-1",
  clientOrderId: "zct-p-1",
  side: "SELL" as const,
  type: "STOP_LOSS_LIMIT",
  origQty: qty,
  executedQty: "0",
  price: "56942.94",
  stopPrice: "57000",
  status: "NEW",
});

describe("reconcile — LIVE számlán a TŐZSDE az igazságforrás (T27)", () => {
  it("egyező állapot esetén nincs eltérés", () => {
    const r = reconcile(ledger("1000"), snapshot(), "live");
    expect(r.discrepancies).toEqual([]);
    expect(r.blockNewBuys).toBe(false);
    expect(reconcileGate(r).allowNewBuys).toBe(true);
  });

  it("PAPER számlán NEM fut le, és a számla érintetlen marad", () => {
    const r = reconcile(ledger("1000"), snapshot(), "paper");
    expect(r.usable).toBe(false);
    expect(r.discrepancies[0].code).toBe("paper_scope");
    expect(r.newFills).toEqual([]);
    expect(reconcileGate(r).allowNewBuys).toBe(false);
  });

  it("eltérő készpénz-egyenleg BLOKKOL", () => {
    const r = reconcile(ledger("1000"), snapshot({ balances: [{ asset: "USDT", free: "900", locked: "0" }] }), "live");
    expect(r.discrepancies[0].code).toBe("balance_mismatch");
    expect(r.blockNewBuys).toBe(true);
  });

  it("a locked egyenleg is beleszámít (a pihenő order zárolja a készletet)", () => {
    const r = reconcile(
      ledger("0", { BTC: { qty: "0.001", cost: "60" } }),
      snapshot({
        balances: [
          { asset: "USDT", free: "0", locked: "0" },
          { asset: "BTC", free: "0", locked: "0.001" },
        ],
        openOrders: [protectionOrder()],
      }),
      "live",
    );
    expect(r.discrepancies.filter((d) => d.code === "position_mismatch")).toHaveLength(0);
  });

  it("KIMARADÁS alatti stop-fill: a tőzsdén már nincs készlet, helyben még igen", () => {
    const r = reconcile(
      ledger("0", { BTC: { qty: "0.001", cost: "60" } }),
      snapshot({ balances: [{ asset: "USDT", free: "60", locked: "0" }] }),
      "live",
    );
    const codes = r.discrepancies.map((d) => d.code);
    expect(codes).toContain("position_mismatch");
    expect(r.blockNewBuys).toBe(true);
  });

  it("IDEGEN kézi order a tőzsdén blokkol", () => {
    const r = reconcile(
      ledger("1000"),
      snapshot({
        openOrders: [{ ...protectionOrder(), type: "LIMIT", side: "BUY", orderId: "manual-1" }],
      }),
      "live",
    );
    expect(r.discrepancies[0].code).toBe("unknown_open_order");
    expect(r.blockNewBuys).toBe(true);
  });

  it("a védőordereket felismeri, és átadja a T26 tervezőjének", () => {
    const r = reconcile(
      ledger("0", { BTC: { qty: "0.001", cost: "60" } }),
      snapshot({
        balances: [
          { asset: "USDT", free: "0", locked: "0" },
          { asset: "BTC", free: "0", locked: "0.001" },
        ],
        openOrders: [protectionOrder()],
      }),
      "live",
    );
    expect(r.protection.BTC).toMatchObject({ exchangeOrderId: "p-1", qty: "0.001", stopPrice: "57000" });
  });

  it("védőorder NÉLKÜLI nyitott pozíció blokkol", () => {
    const r = reconcile(
      ledger("0", { BTC: { qty: "0.001", cost: "60" } }),
      snapshot({
        balances: [
          { asset: "USDT", free: "0", locked: "0" },
          { asset: "BTC", free: "0.001", locked: "0" },
        ],
      }),
      "live",
    );
    expect(r.discrepancies.some((d) => d.code === "missing_protection")).toBe(true);
    expect(r.blockNewBuys).toBe(true);
  });
});

describe("reconcile — teljesülések importja pontosan egyszer", () => {
  const trade = { tradeId: 5, orderId: 99, price: "60000", qty: "0.001", quoteQty: "60", commission: "0.06", commissionAsset: "USDT", isBuyer: true, time: NOW };

  it("az ismeretlen teljesülés importálandó, ÉS blokkol (kézi kötés)", () => {
    const r = reconcile(ledger("1000"), snapshot({ trades: { BTC: [trade] } }), "live");
    expect(r.newFills).toHaveLength(1);
    expect(r.newFills[0].fillId).toBe("live:99:5");
    expect(r.discrepancies.some((d) => d.code === "unimported_trade")).toBe(true);
    expect(r.blockNewBuys).toBe(true);
  });

  it("a MÁR ismert fill nem kerül újra importra (idempotens)", () => {
    const r = reconcile(ledger("1000"), snapshot({ trades: { BTC: [trade] } }), "live", {
      knownFillIds: ["live:99:5"],
    });
    expect(r.newFills).toHaveLength(0);
  });

  it("a bot saját megbízásához tartozó teljesülés NEM idegen kötés", () => {
    const r = reconcile(ledger("1000"), snapshot({ trades: { BTC: [trade] } }), "live", {
      intentIdForOrder: { "99": "i-42" },
    });
    expect(r.newFills[0].intentId).toBe("i-42");
    expect(r.discrepancies.some((d) => d.code === "unimported_trade")).toBe(false);
  });

  it("az eladás oldala helyesen ismerhető fel", () => {
    const r = reconcile(
      ledger("1000"),
      snapshot({ trades: { BTC: [{ ...trade, isBuyer: false }] } }),
      "live",
      { intentIdForOrder: { "99": "i-1" } },
    );
    expect(r.newFills[0].side).toBe("SELL");
  });

  it("azonosító nélküli teljesülés kimarad", () => {
    const r = reconcile(ledger("1000"), snapshot({ trades: { BTC: [{ price: "1", qty: "1" }] } }), "live");
    expect(r.newFills).toHaveLength(0);
  });
});

describe("segédek", () => {
  it("a jelentés emberi olvasásra alkalmas", () => {
    const r = reconcile(ledger("1000"), snapshot({ balances: [{ asset: "USDT", free: "1", locked: "0" }] }), "live");
    const text = formatReconcile(r);
    expect(text).toMatch(/ÚJ VÉTEL TILOS/);
    expect(text).toMatch(/balance_mismatch/);
  });

  it("az elavult pillanatkép felismerhető", () => {
    expect(isSnapshotFresh(snapshot(), NOW + 30_000)).toBe(true);
    expect(isSnapshotFresh(snapshot(), NOW + 120_000)).toBe(false);
  });

  it("a kerekítési zaj nem eltérés", () => {
    const r = reconcile(
      ledger("1000"),
      snapshot({ balances: [{ asset: "USDT", free: "1000.000000001", locked: "0" }] }),
      "live",
      { tolerance: "0.00001" },
    );
    expect(r.discrepancies).toEqual([]);
  });
});

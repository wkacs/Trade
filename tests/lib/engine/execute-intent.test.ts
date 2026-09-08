import { describe, it, expect, vi } from "vitest";
import { executeIntent, type ExecuteIntentDeps, type IntentRequest } from "@/lib/engine/execute-intent";
import { PaperExecutionBroker } from "@/lib/execution/paper-broker";
import { emptyLedger, cashOf, positionQty, type LedgerState } from "@/lib/portfolio/ledger";
import type { OrderRiskContext } from "@/lib/risk/risk-manager";
import type { ExecutionBroker, ExecutionReceipt } from "@/lib/execution/broker";
import { EXECUTION_CONTRACT_VERSION } from "@/lib/execution/contracts";

const NOW = 1_700_000_000_000;

function harness(
  opening = "100",
  positions: Record<string, { qty: string; cost: string }> = {},
  over: Partial<OrderRiskContext> = {},
  brokerOverride?: ExecutionBroker,
) {
  let ledger: LedgerState = {
    ...emptyLedger("pf-1", "paper", opening),
    positions: Object.fromEntries(
      Object.entries(positions).map(([symbol, v]) => [symbol, { symbol, qty: v.qty, costBasisQuote: v.cost, stopPrice: null }]),
    ),
  };
  const market: Record<string, { last: string }> = { BTC: { last: "60000" }, ETH: { last: "3000" } };
  const broker =
    brokerOverride ??
    new PaperExecutionBroker({
      getLedger: () => ledger,
      getMarket: (s) => market[s] ?? null,
      now: () => NOW,
      params: { feePct: "0.001", slippageBps: 0, spreadBps: 0, quoteAsset: "USDT" },
    });

  let counter = 0;
  const deps: ExecuteIntentDeps = {
    portfolioId: "pf-1",
    mode: "paper",
    strategyVersion: "v2-test",
    broker,
    getLedger: () => ledger,
    getRiskContext: () => ({
      ledger,
      prices: { BTC: "60000", ETH: "3000" },
      reservedQuoteBySymbol: {},
      reservedQuoteTotal: "0",
      dailyLossLatched: false,
      dayBaselineMissing: false,
      allowedSymbols: ["BTC", "ETH", "SOL"],
      quoteAsset: "USDT",
      ...over,
    }),
    now: () => NOW,
    newIntentId: () => `i-${++counter}`,
  };
  return {
    deps,
    market,
    get ledger() {
      return ledger;
    },
    run: async (req: IntentRequest) => {
      const r = await executeIntent(req, deps);
      if (r.status === "executed") ledger = r.ledger;
      return r;
    },
  };
}

describe("executeIntent — minden order a közös kapun át", () => {
  it("engedélyezett BUY végrehajtódik és a ledger frissül", async () => {
    const h = harness("100");
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(r.status).toBe("executed");
    expect(Number(cashOf(h.ledger, "USDT"))).toBeCloseTo(90, 9);
    expect(Number(positionQty(h.ledger, "BTC"))).toBeGreaterThan(0);
  });

  it("a kapu vág: 50 USD kérésből 20 lesz (equity 20%-a)", async () => {
    const h = harness("100");
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "50", origin: "ai", referencePrice: "60000" });
    expect(r.status).toBe("executed");
    if (r.status !== "executed") return;
    expect(r.intent.order.side === "BUY" && r.intent.order.maxQuoteSpend).toBe("20");
    expect(Number(cashOf(h.ledger, "USDT"))).toBeCloseTo(80, 9);
  });

  it("AUDIT §1: 20 USD BTC + 80 cash mellett a további BUY nem megy át a brokerhez", async () => {
    const submit = vi.fn();
    const broker: ExecutionBroker = { submit, lookup: vi.fn() };
    const h = harness("80", { BTC: { qty: "1", cost: "20" } }, { prices: { BTC: "20" } }, broker);
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "20", origin: "ai", referencePrice: "20" });
    expect(r.status).toBe("rejected_by_risk");
    expect(submit).not.toHaveBeenCalled();
  });

  it("SELL cash=0 mellett is végrehajtódik (a méret a készletből jön)", async () => {
    const h = harness("0", { BTC: { qty: "0.001", cost: "60" } });
    const r = await h.run({ side: "SELL", symbol: "BTC", baseQty: "0.001", origin: "take-profit", referencePrice: "60000" });
    expect(r.status).toBe("executed");
    expect(Number(cashOf(h.ledger, "USDT"))).toBeCloseTo(60 - 0.06, 9);
    expect(h.ledger.positions.BTC).toBeUndefined();
  });

  it("a DCA eredet-kerete vág, az AI-é nem", async () => {
    const dca = harness("100", {}, { originBudgetQuote: "3" });
    const r1 = await dca.run({ side: "BUY", symbol: "BTC", desiredQuote: "20", origin: "dca", referencePrice: "60000" });
    expect(r1.status === "executed" && r1.intent.order.side === "BUY" && r1.intent.order.maxQuoteSpend).toBe("3");

    const ai = harness("100");
    const r2 = await ai.run({ side: "BUY", symbol: "BTC", desiredQuote: "20", origin: "ai", referencePrice: "60000" });
    expect(r2.status === "executed" && r2.intent.order.side === "BUY" && r2.intent.order.maxQuoteSpend).toBe("20");
  });

  it("broker-elutasításnál nincs könyvelés és a foglalás felszabadul", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const broker: ExecutionBroker = {
      submit: vi.fn().mockResolvedValue({
        exchangeOrderId: null,
        clientOrderId: "zct-i-1",
        state: "rejected",
        fills: [],
        error: { code: "min_notional", message: "túl kicsi" },
      } satisfies ExecutionReceipt),
      lookup: vi.fn(),
    };
    const h = harness("100", {}, {}, broker);
    h.deps.releaseReservation = release;
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(r.status).toBe("rejected_by_broker");
    expect(cashOf(h.ledger, "USDT")).toBe("100");
    expect(release).toHaveBeenCalled();
  });

  it("ismeretlen order-állapot: nem könyvelünk és nem küldünk új azonosítójú ordert", async () => {
    const broker: ExecutionBroker = {
      submit: vi.fn().mockRejectedValue(new Error("timeout")),
      lookup: vi.fn(),
    };
    const h = harness("100", {}, {}, broker);
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(r.status).toBe("unknown");
    expect(cashOf(h.ledger, "USDT")).toBe("100");
  });

  it("sikertelen foglalás esetén nincs order", async () => {
    const submit = vi.fn();
    const broker: ExecutionBroker = { submit, lookup: vi.fn() };
    const h = harness("100", {}, {}, broker);
    h.deps.reserve = vi.fn().mockResolvedValue(false);
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(r.status).toBe("not_reserved");
    expect(submit).not.toHaveBeenCalled();
  });

  it("a perzisztencia hibája NEM néma siker: kifelé dob", async () => {
    const h = harness("100");
    h.deps.persist = vi.fn().mockRejectedValue(new Error("DB down"));
    await expect(
      executeIntent({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" }, h.deps),
    ).rejects.toThrow(/DB down/);
  });

  it("a perzisztencia a fill-lel EGYÜTT kapja a deltakat", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const h = harness("100");
    h.deps.persist = persist;
    await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(persist).toHaveBeenCalledTimes(1);
    const [, fill, deltas] = persist.mock.calls[0];
    expect(fill.side).toBe("BUY");
    expect(deltas.cash[0].asset).toBe("USDT");
    expect(deltas.reservation).toEqual({ intentId: "i-1", consumeQuote: fill.grossQuoteAmount });
  });

  it("a rávásárlás nem írja felül a meglévő stopot, ha nincs explicit stopPrice", async () => {
    let ledger: LedgerState = {
      ...emptyLedger("pf-1", "paper", "100"),
      positions: { BTC: { symbol: "BTC", qty: "0.0001", costBasisQuote: "6", stopPrice: "59000" } },
    };
    const broker = new PaperExecutionBroker({
      getLedger: () => ledger,
      getMarket: () => ({ last: "60000" }),
      now: () => NOW,
      params: { feePct: "0.001", slippageBps: 0, spreadBps: 0, quoteAsset: "USDT" },
    });
    const deps: ExecuteIntentDeps = {
      portfolioId: "pf-1",
      mode: "paper",
      strategyVersion: "v2-test",
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
      now: () => NOW,
      newIntentId: () => "i-add",
    };
    const r = await executeIntent(
      { side: "BUY", symbol: "BTC", desiredQuote: "5", origin: "dca", referencePrice: "60000" },
      deps,
    );
    expect(r.status).toBe("executed");
    if (r.status !== "executed") return;
    expect(r.ledger.positions.BTC.stopPrice).toBe("59000");
  });

  it("az intent hordozza a hatókört és a lejáratot", async () => {
    const h = harness("100");
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(r.status).toBe("executed");
    if (r.status !== "executed") return;
    expect(r.intent.portfolioId).toBe("pf-1");
    expect(r.intent.mode).toBe("paper");
    expect(r.intent.strategyVersion).toBe("v2-test");
    expect(r.intent.contractVersion).toBe(EXECUTION_CONTRACT_VERSION);
    expect(r.intent.expiresAt).toBeGreaterThan(NOW);
  });
});

describe("executeIntent — tranzakciós perzisztencia (T09)", () => {
  it("a strukturált perzisztencia-hiba felszínre jön, nem lesz belőle hamis siker", async () => {
    const h = harness("100");
    h.deps.persist = vi.fn().mockRejectedValue(
      Object.assign(new Error("apply_fill_v2 failed"), { code: "write_failed" }),
    );
    await expect(
      executeIntent({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" }, h.deps),
    ).rejects.toThrow(/apply_fill_v2 failed/);
  });

  it("a foglalás a BUY összegére szól, és a broker csak utána kap ordert", async () => {
    const order: string[] = [];
    const submit = vi.fn(async () => {
      order.push("submit");
      return { exchangeOrderId: "x", clientOrderId: "c", state: "rejected" as const, fills: [], error: { code: "e", message: "m" } };
    });
    const h = harness("100", {}, {}, { submit, lookup: vi.fn() });
    h.deps.reserve = vi.fn(async (_intent, quote) => {
      order.push(`reserve:${quote}`);
      return true;
    });
    await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "50", origin: "ai", referencePrice: "60000" });
    expect(order).toEqual(["reserve:20", "submit"]);
  });

  it("SELL-nél nincs quote-foglalás (a készpénz nem játszik)", async () => {
    const h = harness("0", { BTC: { qty: "0.001", cost: "60" } });
    const reserve = vi.fn(async () => true);
    h.deps.reserve = reserve;
    await h.run({ side: "SELL", symbol: "BTC", baseQty: "0.001", origin: "stop-loss", referencePrice: "60000" });
    expect(reserve).toHaveBeenCalledWith(expect.anything(), "0");
  });

  it("az intent-napló a beküldés kimenetelét is megkapja", async () => {
    const recordIntent = vi.fn(async () => undefined);
    const h = harness("100");
    h.deps.recordIntent = recordIntent;
    await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(recordIntent).toHaveBeenCalledTimes(1);
    const [, receipt] = recordIntent.mock.calls[0] as unknown[];
    expect((receipt as { state: string }).state).toBe("filled");
  });

  it("ismeretlen kimenetelnél a napló receipt nélkül fut le (egyeztetés következik)", async () => {
    const recordIntent = vi.fn(async () => undefined);
    const broker = { submit: vi.fn().mockRejectedValue(new Error("timeout")), lookup: vi.fn() };
    const h = harness("100", {}, {}, broker);
    h.deps.recordIntent = recordIntent;
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(r.status).toBe("unknown");
    const [, receipt] = recordIntent.mock.calls[0] as unknown[];
    expect(receipt).toBeNull();
  });
});

// ── A TARTÓS könyvelés eredménye az execution szerződés része (audit 7.) ─────────

describe("executeIntent — elutasított tartós könyvelés", () => {
  it("fencing-elutasítás MEGÁLLÍTJA a végrehajtást (nincs hamis siker)", async () => {
    const h = harness("100");
    h.deps.persist = async () => ({ applied: false, reason: "fenced" });
    await expect(
      h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" }),
    ).rejects.toThrow(/fenced/);
  });

  it("a memóriabeli ledger sem költ tovább egy elutasított könyvelés után", async () => {
    const h = harness("100");
    h.deps.persist = async () => ({ applied: false, reason: "fenced" });
    await h
      .run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" })
      .catch(() => undefined);
    // A hívó ledgere érintetlen: a dobás előtt nem vezettük tovább az állapotot.
    expect(Number(cashOf(h.ledger, "USDT"))).toBe(100);
    expect(Number(positionQty(h.ledger, "BTC"))).toBe(0);
  });

  it("duplikátum: idempotens ág, nem hiba (a DB már könyvelte)", async () => {
    const h = harness("100");
    h.deps.persist = async () => ({ applied: false, reason: "duplicate_fill" });
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(r.status).toBe("executed");
  });

  it("a régi, void-ot adó persist változatlanul működik", async () => {
    const h = harness("100");
    h.deps.persist = async () => undefined;
    const r = await h.run({ side: "BUY", symbol: "BTC", desiredQuote: "10", origin: "ai", referencePrice: "60000" });
    expect(r.status).toBe("executed");
    expect(Number(cashOf(h.ledger, "USDT"))).toBeCloseTo(90, 9);
  });
});

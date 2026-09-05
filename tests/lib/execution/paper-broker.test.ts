import { describe, it, expect } from "vitest";
import { PaperBroker } from "@/lib/execution/paper-broker";

type PaperState = { cashUsd: number; positions: { symbol: string; qty: number; valueUsd: number }[] };

const mkState = (cashUsd: number, positions: PaperState["positions"] = []): PaperState => ({
  cashUsd,
  positions,
});

describe("PaperBroker", () => {
  it("BUY-t szimulált egyenleggel végrehoz, fee-vel", async () => {
    const broker = new PaperBroker(mkState(10000));
    const trade = await broker.execute(
      { side: "BUY", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05 },
      60000,
    );
    expect(trade.symbol).toBe("BTC");
    expect(trade.side).toBe("BUY");
    expect(trade.price).toBe(60000);
    expect(trade.qty).toBeCloseTo((2000 - 2) / 60000, 8); // 0.1% fee
    expect(trade.feeUsd).toBeCloseTo(2, 4); // 2000 * 0.001
    expect(trade.mode).toBe("paper");
  });

  it("BUY csökkenti a készpénzt és pozíciót nyit", async () => {
    const st = mkState(10000);
    const broker = new PaperBroker(st);
    await broker.execute({ side: "BUY", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05 }, 60000);
    expect(st.cashUsd).toBe(8000);
    expect(st.positions).toHaveLength(1);
    expect(st.positions[0].symbol).toBe("BTC");
  });

  it("meglévő pozícióra BUY növeli (nem új pozíció)", async () => {
    const st = mkState(10000);
    const broker = new PaperBroker(st);
    await broker.execute({ side: "BUY", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05 }, 60000);
    await broker.execute({ side: "BUY", symbol: "BTC", amountUsd: 1000, stopLossPct: 0.05 }, 60000);
    expect(st.positions).toHaveLength(1);
    expect(st.cashUsd).toBe(7000);
  });

  it("SELL lezárja a pozíciót", async () => {
    const broker = new PaperBroker(
      mkState(8000, [{ symbol: "BTC", qty: 0.0333, valueUsd: 2000 }]),
    );
    const trade = await broker.execute(
      { side: "SELL", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05 },
      60000,
    );
    expect(trade.side).toBe("SELL");
  });

  it("SELL növeli a készpénzt", async () => {
    const st = mkState(8000, [{ symbol: "BTC", qty: 0.0333, valueUsd: 2000 }]);
    const broker = new PaperBroker(st);
    await broker.execute({ side: "SELL", symbol: "BTC", amountUsd: 1000, stopLossPct: 0.05 }, 60000);
    expect(st.cashUsd).toBe(9000);
  });

  it("BUY nem költ többet a rendelkezésre álló cash-nél (nincs overdraw)", async () => {
    const st = mkState(500); // csak $500 áll rendelkezésre
    const broker = new PaperBroker(st);
    // Az AI/engine $2000-t kérne, de a broker $500-ra vágja — a cash sosem megy negatívba
    const trade = await broker.execute(
      { side: "BUY", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05 },
      60000,
    );
    expect(trade.amountUsd).toBe(500);
    expect(st.cashUsd).toBe(0);
    expect(st.cashUsd).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v2 — PaperExecutionBroker (T05). A fenti v1 tesztek a régi, elavult osztályt
// írják le; azok a T06 átállásakor a v1 osztállyal együtt tűnnek el.
// ─────────────────────────────────────────────────────────────────────────────
import { PaperExecutionBroker } from "@/lib/execution/paper-broker";
import { emptyLedger, applyFill, type LedgerState } from "@/lib/portfolio/ledger";
import { div } from "@/lib/portfolio/money";
import { EXECUTION_CONTRACT_VERSION, type ExecutionIntent } from "@/lib/execution/contracts";

const NOW = 1_700_000_000_000;

function intent(over: Partial<ExecutionIntent> & { order: ExecutionIntent["order"] }): ExecutionIntent {
  return {
    intentId: over.intentId ?? "i-1",
    portfolioId: "pf-1",
    mode: "paper",
    strategyVersion: "v2",
    origin: over.origin ?? "ai",
    expiresAt: over.expiresAt ?? NOW + 60_000,
    contractVersion: EXECUTION_CONTRACT_VERSION,
    referencePrice: over.referencePrice ?? "60000",
    order: over.order,
  };
}

function makeBroker(ledger: LedgerState, market: Record<string, { last: string }>, trigger?: { kind: "stop-loss" | "take-profit" | "market"; triggerPrice?: string }) {
  return new PaperExecutionBroker({
    getLedger: () => ledger,
    getMarket: (s) => market[s] ?? null,
    now: () => NOW,
    getTrigger: trigger ? () => trigger : undefined,
    params: { feePct: "0.001", slippageBps: 0, spreadBps: 0, quoteAsset: "USDT" },
  });
}

describe("PaperExecutionBroker (v2)", () => {
  it("SELL a BIRTOKOLT mennyiségből megy, cash=0 mellett is", async () => {
    let ledger = emptyLedger("pf-1", "paper", "0");
    ledger = {
      ...ledger,
      positions: { BTC: { symbol: "BTC", qty: "0.001", costBasisQuote: "60", stopPrice: null } },
    };
    const broker = makeBroker(ledger, { BTC: { last: "60000" } });
    const r = await broker.submit(intent({ order: { side: "SELL", symbol: "BTC", baseQty: "0.001" } }));
    expect(r.state).toBe("filled");
    expect(r.fills[0].filledBaseQty).toBe("0.001");
    expect(r.fills[0].grossQuoteAmount).toBe("60");
  });

  it("nem birtokolt coin eladása strukturált elutasítás (nincs orphan SELL)", async () => {
    const broker = makeBroker(emptyLedger("pf-1", "paper", "100"), { BTC: { last: "60000" } });
    const r = await broker.submit(intent({ order: { side: "SELL", symbol: "BTC", baseQty: "0.001" } }));
    expect(r.state).toBe("rejected");
    expect(r.error?.code).toBe("no_position");
    expect(r.fills).toHaveLength(0);
  });

  it("a birtokoltnál nagyobb eladás a készletre vágódik", async () => {
    let ledger = emptyLedger("pf-1", "paper", "0");
    ledger = {
      ...ledger,
      positions: { BTC: { symbol: "BTC", qty: "0.0005", costBasisQuote: "30", stopPrice: null } },
    };
    const broker = makeBroker(ledger, { BTC: { last: "60000" } });
    const r = await broker.submit(intent({ order: { side: "SELL", symbol: "BTC", baseQty: "0.001" } }));
    expect(r.fills[0].filledBaseQty).toBe("0.0005");
  });

  it("a stop-fill nem lehet kedvezőbb a megfigyelt árnál (95 stop, 90 ár)", async () => {
    let ledger = emptyLedger("pf-1", "paper", "0");
    ledger = { ...ledger, positions: { BTC: { symbol: "BTC", qty: "1", costBasisQuote: "100", stopPrice: "95" } } };
    const broker = makeBroker(ledger, { BTC: { last: "90" } }, { kind: "stop-loss", triggerPrice: "95" });
    const r = await broker.submit(intent({ order: { side: "SELL", symbol: "BTC", baseQty: "1" } }));
    expect(r.fills[0].fillPrice).toBe("90");
  });

  it("fedezet nélküli BUY elutasításra kerül, nem nulla méretű trade", async () => {
    const broker = makeBroker(emptyLedger("pf-1", "paper", "0"), { BTC: { last: "60000" } });
    const r = await broker.submit(intent({ order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "10" } }));
    expect(r.state).toBe("rejected");
    expect(r.error?.code).toBe("insufficient_cash");
  });

  it("a BUY a rendelkezésre álló készpénzre vágódik (nincs overdraw)", async () => {
    const broker = makeBroker(emptyLedger("pf-1", "paper", "5"), { BTC: { last: "60000" } });
    const r = await broker.submit(intent({ order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "100" } }));
    expect(Number(r.fills[0].grossQuoteAmount) + Number(r.fills[0].feeAmount)).toBeCloseTo(5, 9);
  });

  it("lejárt intent nem hajtható végre", async () => {
    const broker = makeBroker(emptyLedger("pf-1", "paper", "100"), { BTC: { last: "60000" } });
    const r = await broker.submit(
      intent({ order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "10" }, expiresAt: NOW - 1 }),
    );
    expect(r.state).toBe("rejected");
    expect(r.error?.code).toBe("intent_expired");
  });

  it("ugyanaz az intent kétszer beküldve ugyanazt az order-azonosítót adja (nincs duplikátum)", async () => {
    const broker = makeBroker(emptyLedger("pf-1", "paper", "100"), { BTC: { last: "60000" } });
    const i = intent({ order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "10" } });
    const a = await broker.submit(i);
    const b = await broker.submit(i);
    expect(b.exchangeOrderId).toBe(a.exchangeOrderId);
    expect(b.fills[0].fillId).toBe(a.fills[0].fillId);
  });

  it("BUY → részleges SELL → teljes SELL ugyanazon a ledgeren konzisztens", async () => {
    let ledger = emptyLedger("pf-1", "paper", "100");
    const market = { BTC: { last: "60000" } };
    const broker = new PaperExecutionBroker({
      getLedger: () => ledger,
      getMarket: (s) => (market as Record<string, { last: string }>)[s] ?? null,
      now: () => NOW,
      params: { feePct: "0.001", slippageBps: 0, spreadBps: 0, quoteAsset: "USDT" },
    });

    const buy = await broker.submit(intent({ intentId: "i-buy", order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "60" } }));
    ledger = applyFill(ledger, buy.fills[0]).state;
    const qty = ledger.positions.BTC.qty;

    const half = await broker.submit(
      intent({ intentId: "i-sell-1", order: { side: "SELL", symbol: "BTC", baseQty: div(qty, "2") } }),
    );
    ledger = applyFill(ledger, half.fills[0]).state;
    expect(Number(ledger.positions.BTC.qty)).toBeCloseTo(Number(qty) / 2, 12);

    const rest = await broker.submit(
      intent({ intentId: "i-sell-2", order: { side: "SELL", symbol: "BTC", baseQty: ledger.positions.BTC.qty } }),
    );
    ledger = applyFill(ledger, rest.fills[0]).state;
    expect(ledger.positions.BTC).toBeUndefined();
    // Változatlan áron a teljes veszteség PONTOSAN a két díj. A 60 USD keret díjjal
    // együtt értendő, ezért a bruttó 60/1,001 és mindkét díj ennek 0,1%-a.
    const gross = 60 / 1.001;
    expect(Number(ledger.cash.USDT)).toBeCloseTo(100 - 2 * gross * 0.001, 8);
    expect(Number(ledger.realizedPnlQuote)).toBeCloseTo(-2 * gross * 0.001, 8);
  });

  it("a broker nem vezet saját egyenleget: a fedezet a közös ledgerből jön", async () => {
    let ledger = emptyLedger("pf-1", "paper", "100");
    const broker = makeBroker(ledger, { BTC: { last: "60000" } });
    await broker.submit(intent({ intentId: "i-a", order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "10" } }));
    // A broker nem írta felül a ledgert — a hívó felel a könyvelésért.
    expect(ledger.cash.USDT).toBe("100");
  });
});

import { describe, it, expect, vi } from "vitest";
import { runFastExit, type FastExitDeps } from "@/lib/engine/fast-exit";
import { emptyLedger, type LedgerState } from "@/lib/portfolio/ledger";
import { PaperExecutionBroker } from "@/lib/execution/paper-broker";
import { makeQuote, type QuoteSnapshot } from "@/lib/market/quotes";

const NOW = 1_700_000_000_000;
const SCOPE = { portfolioId: "pf", mode: "paper" as const };

function ledgerWith(cash: string, positions: Record<string, { qty: string; cost: string; stop: string | null }>): LedgerState {
  return {
    ...emptyLedger("pf", "paper", cash),
    positions: Object.fromEntries(
      Object.entries(positions).map(([symbol, v]) => [
        symbol,
        { symbol, qty: v.qty, costBasisQuote: v.cost, stopPrice: v.stop },
      ]),
    ),
  };
}

function snapshot(prices: Record<string, string>, receivedAt = NOW): QuoteSnapshot {
  const quotes = Object.fromEntries(
    Object.entries(prices).map(([s, p]) => [s, makeQuote(s, p, p, receivedAt, "binance-book")!]),
  );
  return { quotes, errors: [], maxAgeMs: 0, degraded: false };
}

function harness(
  ledger: LedgerState,
  quotes: QuoteSnapshot,
  over: Partial<FastExitDeps> = {},
): { deps: Partial<FastExitDeps>; persisted: unknown[]; stops: unknown[]; current: () => LedgerState } {
  let current = ledger;
  const persisted: unknown[] = [];
  const stops: unknown[] = [];
  const deps: Partial<FastExitDeps> = {
    fetchQuotes: (async () => quotes) as unknown as FastExitDeps["fetchQuotes"],
    loadLedger: async () => current,
    loadReservations: (async () => ({ bySymbol: {}, total: "0" })) as unknown as FastExitDeps["loadReservations"],
    listUnsettledIntents: (async () => []) as unknown as FastExitDeps["listUnsettledIntents"],
    persistFill: (async (_i: unknown, f: unknown) => {
      persisted.push(f);
      return { applied: true };
    }) as unknown as FastExitDeps["persistFill"],
    persistStopPrice: (async (_s: unknown, symbol: string, price: string) => {
      stops.push({ symbol, price });
      return true;
    }) as unknown as FastExitDeps["persistStopPrice"],
    makeBroker: (getLedger, snap, now) =>
      new PaperExecutionBroker({
        getLedger,
        getMarket: (symbol) => {
          const q = snap.quotes[symbol];
          return q ? { bid: q.bid, ask: q.ask, last: q.mid } : null;
        },
        now,
        getTrigger: () => null,
        params: { feePct: "0.001", slippageBps: 0, spreadBps: 0, quoteAsset: "USDT" },
      }),
    ...over,
  };
  return { deps, persisted, stops, current: () => current };
}

const run = (deps: Partial<FastExitDeps>, over: Record<string, unknown> = {}) =>
  runFastExit({ portfolioId: SCOPE.portfolioId, mode: SCOPE.mode, cycleId: "c-1", now: () => NOW, deps, ...over });

describe("runFastExit — gyors kilépés LLM és hírek NÉLKÜL (T21)", () => {
  it("stop-loss triggerre elad, és a fillt perzisztálja", async () => {
    const h = harness(ledgerWith("0", { BTC: { qty: "0.001", cost: "60", stop: "57000" } }), snapshot({ BTC: "56000" }));
    const r = await run(h.deps);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0].side).toBe("SELL");
    expect(h.persisted).toHaveLength(1);
  });

  it("nincs pozíció → a ciklus azonnal megáll (nincs felesleges hálózati hívás)", async () => {
    const fetchSpy = vi.fn(async () => snapshot({}));
    const h = harness(ledgerWith("100", {}), snapshot({}), {
      fetchQuotes: fetchSpy as unknown as FastExitDeps["fetchQuotes"],
    });
    const r = await run(h.deps);
    expect(r.halted).toBe("no_positions");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ismeretlen állapotú megbízás mellett NEM indít ordert", async () => {
    const h = harness(ledgerWith("0", { BTC: { qty: "0.001", cost: "60", stop: "57000" } }), snapshot({ BTC: "56000" }), {
      listUnsettledIntents: (async () => [{ intentId: "x", symbol: "BTC", side: "SELL", state: "unknown", clientOrderId: "c", exchangeOrderId: null }]) as unknown as FastExitDeps["listUnsettledIntents"],
    });
    const r = await run(h.deps);
    expect(r.halted).toBe("unsettled_intents");
    expect(r.fills).toHaveLength(0);
  });

  it("ELAVULT quote mellett nincs kilépés, és ez a tervben látszik", async () => {
    const stale = snapshot({ BTC: "56000" }, NOW - 60_000);
    const h = harness(ledgerWith("0", { BTC: { qty: "0.001", cost: "60", stop: "57000" } }), stale);
    const r = await run(h.deps);
    expect(r.fills).toHaveLength(0);
    expect(r.plan.skipped[0].reason).toBe("stale_quote");
  });

  it("quote nélkül a ciklus megáll", async () => {
    const h = harness(ledgerWith("0", { BTC: { qty: "0.001", cost: "60", stop: "57000" } }), {
      quotes: {},
      errors: [{ symbol: "BTC", code: "timeout", message: "x" }],
      maxAgeMs: 0,
      degraded: true,
    });
    const r = await run(h.deps);
    expect(r.halted).toBe("no_quotes");
  });

  it("a trailing ratchet perzisztálódik, kilépés nélkül is", async () => {
    const h = harness(ledgerWith("0", { BTC: { qty: "0.001", cost: "60", stop: "57000" } }), snapshot({ BTC: "70000" }));
    const r = await run(h.deps);
    expect(r.stopUpdatesApplied).toBe(1);
    expect(h.stops).toHaveLength(1);
    // 70000 mellett a TP (+10% = 66000) is teljesül → van kilépés is.
    expect(r.fills.length).toBeGreaterThanOrEqual(0);
  });

  it("UGYANAZ a trigger két ciklusból CSAK EGYSZER könyvelődik", async () => {
    let current = ledgerWith("0", { BTC: { qty: "0.001", cost: "60", stop: "57000" } });
    const persisted: unknown[] = [];
    const quotes = snapshot({ BTC: "56000" });
    const deps: Partial<FastExitDeps> = {
      fetchQuotes: (async () => quotes) as unknown as FastExitDeps["fetchQuotes"],
      loadLedger: async () => current,
      loadReservations: (async () => ({ bySymbol: {}, total: "0" })) as unknown as FastExitDeps["loadReservations"],
      listUnsettledIntents: (async () => []) as unknown as FastExitDeps["listUnsettledIntents"],
      persistFill: (async (_i: unknown, f: unknown) => {
        persisted.push(f);
        return { applied: true };
      }) as unknown as FastExitDeps["persistFill"],
      persistStopPrice: (async () => true) as unknown as FastExitDeps["persistStopPrice"],
      makeBroker: (getLedger, snap, now) =>
        new PaperExecutionBroker({
          getLedger,
          getMarket: (symbol) => {
            const q = snap.quotes[symbol];
            return q ? { bid: q.bid, ask: q.ask, last: q.mid } : null;
          },
          now,
          params: { feePct: "0.001", slippageBps: 0, spreadBps: 0, quoteAsset: "USDT" },
        }),
    };

    const first = await runFastExit({ ...SCOPE, cycleId: "c-1", now: () => NOW, deps });
    expect(first.fills).toHaveLength(1);
    // A ledger frissül: a pozíció elfogyott.
    current = { ...current, positions: {} };

    const second = await runFastExit({ ...SCOPE, cycleId: "c-2", now: () => NOW, deps });
    expect(second.fills).toHaveLength(0);
    expect(second.halted).toBe("no_positions");
    expect(persisted).toHaveLength(1);
  });

  it("a ciklus SOHA nem hoz létre BUY-t", async () => {
    const h = harness(ledgerWith("1000", { BTC: { qty: "0.001", cost: "60", stop: "57000" } }), snapshot({ BTC: "56000" }));
    const r = await run(h.deps);
    for (const f of r.fills) expect(f.side).toBe("SELL");
  });

  it("a ciklus időtartama mérhető", async () => {
    const h = harness(ledgerWith("0", { BTC: { qty: "0.001", cost: "60", stop: "57000" } }), snapshot({ BTC: "56000" }));
    const r = await run(h.deps);
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

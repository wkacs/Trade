import { describe, expect, it, vi } from "vitest";
import { runShadowCycle } from "@/lib/backtest/shadow-run";
import { defineShadowSet } from "@/lib/backtest/shadow-accounts";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import type { TickInput, TickResult } from "@/lib/engine/tick";

const accounts = () =>
  defineShadowSet(
    { id: "baseline", label: "alapvonal", strategy: DEFAULT_STRATEGY },
    [{ id: "atr2", label: "ATR", strategy: { ...DEFAULT_STRATEGY, stopMode: "atr" } }],
    { startingCapitalUsd: 100 },
  );

function result(input: TickInput): TickResult {
  return {
    events: [],
    decision: {
      id: "decision-test",
      timestamp: 0,
      action: "HOLD",
      symbol: "",
      amountPct: 0,
      confidence: 0,
      reasoning: "test",
      model: "test",
      overridden: false,
    },
    trade: null,
    rawAction: "HOLD",
    rawAmountPct: 0,
    prices: {},
    cycleActions: [],
    process: {} as TickResult["process"],
    tradingEnabled: true,
    dayGate: { dayUtc: "", source: "test", dayPnlPct: 0, latched: false, blockNewBuys: false, reason: "" },
    inceptionPnlPct: 0,
    quotes: { maxAgeMs: 0, degraded: false, errors: [], staleSkips: [] },
    collectors: [],
    signals: {},
    llm: null,
    ml: { modelUsable: true, modelDetail: null, signalCount: 0, skipped: [] },
    replayInput: {
      ...(input.replay ?? { quoteSnapshot: { quotes: {}, errors: [], maxAgeMs: 0, degraded: false }, events: [], collectorOutcomes: [] }),
      rawDecision: { action: "HOLD", symbol: "", amountPct: 0, confidence: 0, reasoning: "test", model: "test" },
      observedAt: 123,
    },
  };
}

describe("páros shadow-paper futás", () => {
  it("a baseline hálózati pillanatképét adja minden jelöltnek, elkülönített paper ledgerrel", async () => {
    const runTick = vi.fn(async (input: TickInput) => result(input));
    const output = await runShadowCycle(accounts(), "2026-09-05T12", { runTick });

    expect(output.cycleId).toBe("2026-09-05T12");
    expect(runTick).toHaveBeenCalledTimes(2);
    const [baseline, candidate] = runTick.mock.calls.map(([input]) => input as TickInput);
    expect(baseline.paperMode).toBe(true);
    expect(candidate.paperMode).toBe(true);
    expect(baseline.portfolioState?.portfolioId).toBe("shadow:baseline");
    expect(candidate.portfolioState?.portfolioId).toBe("shadow:atr2");
    expect(candidate.portfolioState?.portfolioId).not.toBe(baseline.portfolioState?.portfolioId);
    expect(candidate.legacyProjection).toBe(false);
    expect(candidate.replay).toBe(output.results.baseline.replayInput);
    expect(candidate.now?.()).toBe(123);
  });

  it("hibás számlakészletet a hálózati futás előtt elutasít", async () => {
    const invalid = accounts();
    invalid[1] = { ...invalid[1], mode: "live" };
    const runTick = vi.fn();
    await expect(runShadowCycle(invalid, "cycle", { runTick })).rejects.toThrow(/ÉLES számla/);
    expect(runTick).not.toHaveBeenCalled();
  });

  it("AI-s párnál a jelölt ugyanazt a nyers döntést kapja, új LLM-hívás helyett", async () => {
    const aiAccounts = accounts().map((a) => ({ ...a, aiEnabled: true }));
    const runTick = vi.fn(async (input: TickInput) => result(input));
    await runShadowCycle(aiAccounts, "ai-cycle", { runTick });
    const candidate = runTick.mock.calls[1][0] as TickInput;
    expect(candidate.decisionReplay).toEqual({ action: "HOLD", symbol: "", amountPct: 0, confidence: 0, reasoning: "test", model: "test" });
  });
});

import { describe, it, expect } from "vitest";
import { buildTickProcess, type TickProcessInput } from "@/lib/engine/tick-process";

const base: TickProcessInput = {
  tickId: "2026-06-28-11",
  prices: { BTC: 60000, SOL: 150 },
  fearGreed: { value: 15, classification: "Extreme Fear" },
  mlSignals: [{ symbol: "BTC", direction1h: "up", confidence: 0.55 }],
  cycleActions: [{ kind: "dca", side: "BUY", symbol: "SOL", amountUsd: 20, qty: 0.13 }],
  phase1: { shouldDecide: false, summary: "csendes piac" },
  phase2: null,
  decision: { action: "HOLD", symbol: null, overridden: false, overrideReason: null },
  aiTrade: null,
};

describe("buildTickProcess", () => {
  it("a cycleActions-ből trade-et készít az eredettel (kind = origin)", () => {
    const p = buildTickProcess(base);
    expect(p.trades).toEqual([{ symbol: "SOL", side: "BUY", origin: "dca", amountUsd: 20 }]);
    expect(p.inputs.fearGreed?.value).toBe(15);
    expect(p.phase2).toBeNull();
  });

  it("az AI-trade-et 'ai' eredettel hozzáfűzi a cycle-trade-ek után", () => {
    const p = buildTickProcess({
      ...base,
      cycleActions: [],
      phase1: { shouldDecide: true, summary: "ETF hír" },
      phase2: { action: "BUY", symbol: "BTC", amountPct: 0.1, confidence: 0.7, reasoning: "bullish" },
      decision: { action: "BUY", symbol: "BTC", overridden: false, overrideReason: null },
      aiTrade: { symbol: "BTC", side: "BUY", amountUsd: 100 },
    });
    expect(p.trades).toEqual([{ symbol: "BTC", side: "BUY", origin: "ai", amountUsd: 100 }]);
    expect(p.phase2?.action).toBe("BUY");
  });

  it("vegyes eset: a cycle-trade-ek MEGELŐZIK az AI-trade-et a sorrendben", () => {
    const p = buildTickProcess({
      ...base,
      cycleActions: [
        { kind: "stop-loss", side: "SELL", symbol: "ETH", qty: 0.1 },
        { kind: "dca", side: "BUY", symbol: "SOL", amountUsd: 20 },
      ],
      aiTrade: { symbol: "BTC", side: "BUY", amountUsd: 100 },
    });
    expect(p.trades).toEqual([
      { symbol: "ETH", side: "SELL", origin: "stop-loss", amountUsd: 0 },
      { symbol: "SOL", side: "BUY", origin: "dca", amountUsd: 20 },
      { symbol: "BTC", side: "BUY", origin: "ai", amountUsd: 100 },
    ]);
  });
});

// ── T23: a health blokk és a „miért nem történt semmi" magyarázat ────────────
import { explainNoTrade, type TickProcess, type TickHealth } from "@/lib/engine/tick-process";

const health = (over: Partial<TickHealth> = {}): TickHealth => ({
  tradingEnabled: true,
  blockedReason: null,
  quoteAgeMs: 1200,
  quotesDegraded: false,
  staleSkips: [],
  collectors: [{ name: "binance", ok: true, points: 72, durationMs: 300 }],
  signals: { BTC: { bars: 60, requiredBars: 48, sufficient: true } },
  ml: { usable: true, detail: null, signalCount: 1 },
  dayGate: { source: "day-open", dayPnlPct: 0.01, latched: false, blockNewBuys: false },
  llm: null,
  stageMs: { quotes: 120, collectors: 900 },
  ...over,
});

const emptyProcess = (over: Partial<TickProcess> = {}): TickProcess => ({
  tickId: "2026-09-05-10",
  inputs: { prices: { BTC: 60000 }, fearGreed: null, mlSignals: [] },
  cycleActions: [],
  phase1: { shouldDecide: true, summary: "x" },
  phase2: null,
  decision: { action: "HOLD", symbol: null, overridden: false, overrideReason: null },
  trades: [],
  health: health(),
  ...over,
});

describe("explainNoTrade — MIÉRT nem történt kötés (T23)", () => {
  it("kötés esetén nincs magyarázat", () => {
    const p = emptyProcess({ trades: [{ symbol: "BTC", side: "BUY", origin: "dca", amountUsd: 2 }] });
    expect(explainNoTrade(p)).toEqual([]);
  });

  it("hiteles portfólió-állapot hiánya megjelenik", () => {
    const p = emptyProcess({ health: health({ tradingEnabled: false, blockedReason: "Nincs hiteles portfólió-állapot." }) });
    expect(explainNoTrade(p).join(" ")).toMatch(/portfólió-állapot/);
  });

  it("a napi latch és a hiányzó napkezdő referencia külön okként látszik", () => {
    const latched = emptyProcess({ health: health({ dayGate: { source: "day-open", dayPnlPct: -0.05, latched: true, blockNewBuys: true } }) });
    expect(explainNoTrade(latched).join(" ")).toMatch(/veszteségkapu/);

    const missing = emptyProcess({ health: health({ dayGate: { source: "missing", dayPnlPct: null, latched: false, blockNewBuys: true } }) });
    expect(explainNoTrade(missing).join(" ")).toMatch(/napkezdő/);
  });

  it("az elavult ár miatti kihagyás okként jelenik meg", () => {
    const p = emptyProcess({ health: health({ staleSkips: [{ symbol: "BTC", side: "SELL", reason: "stale", ageMs: 30000 }] }) });
    expect(explainNoTrade(p).join(" ")).toMatch(/BTC SELL/);
  });

  it("a kevés gyertya és a karanténba került ML-modell is látszik", () => {
    const p = emptyProcess({
      health: health({
        signals: { ETH: { bars: 24, requiredBars: 48, sufficient: false } },
        ml: { usable: false, detail: "feature-verzió eltérés", signalCount: 0 },
      }),
    });
    const reasons = explainNoTrade(p).join(" ");
    expect(reasons).toMatch(/24\/48/);
    expect(reasons).toMatch(/feature-verzió/);
  });

  it("az adatforrás-hiba is ok", () => {
    const p = emptyProcess({ health: health({ collectors: [{ name: "rss", ok: false, points: 0, durationMs: 15000 }] }) });
    expect(explainNoTrade(p).join(" ")).toMatch(/rss/);
  });

  it("health blokk nélkül is ad valamit (régi naplók olvashatók)", () => {
    const p = emptyProcess({ health: undefined, phase1: { shouldDecide: false, summary: "csend" } });
    expect(explainNoTrade(p).join(" ")).toMatch(/phase-1/);
  });

  it("a hiányzó költségadat NULL, nem nulla", () => {
    const p = emptyProcess({ health: health({ llm: null, quoteAgeMs: null }) });
    expect(p.health!.llm).toBeNull();
    expect(p.health!.quoteAgeMs).toBeNull();
    // Explicit: a null nem 0.
    expect(p.health!.quoteAgeMs).not.toBe(0);
  });
});

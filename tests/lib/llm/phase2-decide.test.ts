import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, chatJson: vi.fn() };
});

import { chatJson } from "@/lib/llm/client";
import { decide, PHASE2_PROMPT_VERSION, type DecideInput } from "@/lib/llm/phase2-decide";
import { normalizePhase2, DECISION_SCHEMA_VERSION } from "@/lib/llm/schemas";

const usage = (over: Partial<import("@/lib/llm/client").LlmUsage> = {}) => ({
  model: "glm-5.2",
  promptVersion: PHASE2_PROMPT_VERSION,
  latencyMs: 120,
  promptTokens: 500,
  completionTokens: 40,
  totalTokens: 540,
  failed: false,
  ...over,
});

const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  events: [],
  mlSignals: [],
  portfolio: {
    cashUsd: 100,
    equityUsd: 160,
    positions: [
      { symbol: "BTC", qty: 0.001, entryPrice: 60000, valueUsd: 60, unrealizedPnlPct: 0, stopPrice: 57000 },
    ],
    freeBuyBudgetUsd: { BTC: 0, ETH: 32, SOL: 32 },
  },
  allowedSymbols: ["BTC", "ETH", "SOL"],
  ...over,
});

const respond = (data: unknown, over: Partial<import("@/lib/llm/client").LlmUsage> = {}) =>
  (chatJson as any).mockResolvedValue({ data, raw: JSON.stringify(data), usage: usage(over) });

describe("phase2 decide — verziózott intent (T16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("v2 BUY: equityFraction megy át", async () => {
    respond({ action: "BUY", symbol: "ETH", equityFraction: 0.15, confidence: 0.7, reasoning: "ETF hír" });
    const r = await decide(input());
    expect(r.decision.action).toBe("BUY");
    expect(r.decision.symbol).toBe("ETH");
    expect(r.decision.equityFraction).toBe(0.15);
    expect(r.decision.positionFraction).toBe(0);
    expect(r.decision.schemaVersion).toBe(DECISION_SCHEMA_VERSION);
  });

  it("AUDIT §2: SELL cash=0 mellett is a POZÍCIÓ hányadát adja", async () => {
    respond({ action: "SELL", symbol: "BTC", positionFraction: 1, confidence: 0.8, reasoning: "kiszállás" });
    const r = await decide(input({ portfolio: { ...input().portfolio, cashUsd: 0 } }));
    expect(r.decision.action).toBe("SELL");
    expect(r.decision.positionFraction).toBe(1);
    expect(r.decision.equityFraction).toBe(0);
  });

  it("a régi v1 alak adapterrel megy át, és a fordítás LÁTSZIK", async () => {
    respond({ action: "BUY", symbol: "ETH", amountPct: 0.1, confidence: 0.6, reasoning: "régi alak" });
    const r = await decide(input());
    expect(r.decision.action).toBe("BUY");
    expect(r.decision.equityFraction).toBe(0.1);
    expect(r.decision.adjustments.join(" ")).toMatch(/v1/);
  });

  it("hibás JSON/séma → HOLD, nem dobás", async () => {
    respond({ nonsense: true });
    const r = await decide(input());
    expect(r.decision.action).toBe("HOLD");
  });

  it("LLM-timeout → HOLD, és a hiba mérhető", async () => {
    (chatJson as any).mockResolvedValue({
      data: null,
      raw: "",
      usage: usage({ failed: true, errorCode: "timeout", errorMessage: "időtúllépés" }),
    });
    const r = await decide(input());
    expect(r.decision.action).toBe("HOLD");
    expect(r.usage.failed).toBe(true);
    expect(r.usage.errorCode).toBe("timeout");
  });

  it("kosáron kívüli szimbólum → HOLD", async () => {
    respond({ action: "BUY", symbol: "DOGE", equityFraction: 0.1, confidence: 0.9, reasoning: "meme" });
    const r = await decide(input());
    expect(r.decision.action).toBe("HOLD");
    expect(r.decision.adjustments.join(" ")).toMatch(/DOGE/);
  });

  it("nem birtokolt coin eladása → HOLD", async () => {
    respond({ action: "SELL", symbol: "SOL", positionFraction: 1, confidence: 0.9, reasoning: "x" });
    const r = await decide(input());
    expect(r.decision.action).toBe("HOLD");
    expect(r.decision.adjustments.join(" ")).toMatch(/nem birtokolt/);
  });

  it("a modell VALÓS belépési árat, equityt és szabad keretet kap", async () => {
    respond({ action: "HOLD", confidence: 0.3, reasoning: "csend" });
    await decide(input());
    const [, , userPrompt] = (chatJson as any).mock.calls[0];
    const payload = JSON.parse(userPrompt);
    expect(payload.portfolio.positions[0].entryPrice).toBe(60000);
    expect(payload.portfolio.positions[0].valueUsd).toBe(60);
    expect(payload.portfolio.equityUsd).toBe(160);
    expect(payload.portfolio.freeBuyBudgetUsd.BTC).toBe(0);
    expect(payload.heldSymbols).toEqual(["BTC"]);
  });

  it("az adatminőség is bemenet (mire NEM támaszkodhat az AI)", async () => {
    respond({ action: "HOLD", confidence: 0.3, reasoning: "csend" });
    await decide(
      input({ dataQuality: { mlUsable: false, staleOrMissingQuotes: ["SOL"], insufficientHistory: ["ETH"] } }),
    );
    const [, , userPrompt] = (chatJson as any).mock.calls[0];
    const payload = JSON.parse(userPrompt);
    expect(payload.dataQuality).toEqual({
      mlUsable: false,
      staleOrMissingQuotes: ["SOL"],
      insufficientHistory: ["ETH"],
    });
  });

  it("a prompt verziózott és a használat mérhető", async () => {
    respond({ action: "HOLD", confidence: 0.3, reasoning: "csend" });
    const r = await decide(input());
    expect(r.usage.promptVersion).toBe(PHASE2_PROMPT_VERSION);
    expect(r.usage.totalTokens).toBe(540);
    expect(r.promptChars).toBeGreaterThan(0);
  });
});

describe("normalizePhase2 — a régi naplók olvashatók maradnak", () => {
  const ctx = { allowedSymbols: ["BTC", "ETH", "SOL"], heldSymbols: ["BTC"] };

  it("v1 SELL amountPct → positionFraction", () => {
    const d = normalizePhase2({ action: "SELL", symbol: "BTC", amountPct: 0.5, confidence: 0.7, reasoning: "x" }, ctx);
    expect(d.positionFraction).toBe(0.5);
    expect(d.equityFraction).toBe(0);
  });

  it("HOLD-nál nincs méret és nincs szimbólum", () => {
    const d = normalizePhase2({ action: "HOLD", confidence: 0.4, reasoning: "semmi" }, ctx);
    expect(d.symbol).toBeNull();
    expect(d.equityFraction).toBe(0);
    expect(d.positionFraction).toBe(0);
  });

  it("nulla hányad HOLD-ra vált (nincs értelmetlen nulla order)", () => {
    expect(normalizePhase2({ action: "BUY", symbol: "ETH", equityFraction: 0, confidence: 0.5, reasoning: "x" }, ctx).action).toBe("HOLD");
    expect(normalizePhase2({ action: "SELL", symbol: "BTC", positionFraction: 0, confidence: 0.5, reasoning: "x" }, ctx).action).toBe("HOLD");
  });

  it("hiányzó szimbólum BUY-nál HOLD", () => {
    const d = normalizePhase2({ action: "BUY", equityFraction: 0.1, confidence: 0.5, reasoning: "x" }, ctx);
    expect(d.action).toBe("HOLD");
  });

  it("a confidence átmegy, de sehol nem találati valószínűség", () => {
    const d = normalizePhase2({ action: "BUY", symbol: "ETH", equityFraction: 0.1, confidence: 0.99, reasoning: "x" }, ctx);
    expect(d.confidence).toBe(0.99);
    // A döntés mérete NEM a confidence-ből származik.
    expect(d.equityFraction).toBe(0.1);
  });

  it("1-nél nagyobb hányadot a séma elutasítja → HOLD", () => {
    const d = normalizePhase2({ action: "BUY", symbol: "ETH", equityFraction: 5, confidence: 0.5, reasoning: "x" }, ctx);
    expect(d.action).toBe("HOLD");
  });
});

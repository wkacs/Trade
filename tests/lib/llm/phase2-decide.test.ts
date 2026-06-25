import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/llm/client", () => ({
  chatJson: vi.fn().mockResolvedValue({
    data: {
      action: "BUY",
      symbol: "BTC",
      amountPct: 0.15,
      confidence: 0.72,
      reasoning: "ETF inflow + whale gyűjtés → bullish.",
    },
    raw: "",
  }),
}));

import { decide } from "@/lib/llm/phase2-decide";

describe("decide (phase-2)", () => {
  it("strukturált döntést ad érveléssel", async () => {
    const d = await decide({
      events: [],
      mlSignals: [],
      portfolio: { cashUsd: 10000, positions: [] },
    });
    expect(d.action).toBe("BUY");
    expect(d.symbol).toBe("BTC");
    expect(d.reasoning).toContain("ETF");
    expect(d.confidence).toBeGreaterThan(0.5);
    expect(d.amountPct).toBeLessThanOrEqual(0.2);
  });

  it("HOLD kimenet is érvényes", async () => {
    const { chatJson } = await import("@/lib/llm/client");
    (chatJson as any).mockResolvedValueOnce({
      data: { action: "HOLD", amountPct: 0, confidence: 0.4, reasoning: "semmi érdemes" },
      raw: "",
    });
    const d = await decide({ events: [], mlSignals: [], portfolio: { cashUsd: 10000, positions: [] } });
    expect(d.action).toBe("HOLD");
  });

  it("fallback (LLM hiba) HOLD-t ad", async () => {
    const { chatJson } = await import("@/lib/llm/client");
    (chatJson as any).mockResolvedValueOnce({
      data: { action: "HOLD", amountPct: 0, confidence: 0.3, reasoning: "LLM hiba, HOLD." },
      raw: "",
    });
    const d = await decide({ events: [], mlSignals: [], portfolio: { cashUsd: 10000, positions: [] } });
    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBeLessThan(0.5);
  });
});

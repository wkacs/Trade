import { describe, it, expect, vi } from "vitest";

// Mock: a chatJson-t kicseréljük, hogy ne igényeljen valós GLM hívást
vi.mock("@/lib/llm/client", () => ({
  chatJson: vi.fn(),
}));

import { chatJson } from "@/lib/llm/client";
import { shouldDecide } from "@/lib/llm/phase1-filter";
import type { DataPoint } from "@/lib/types";

describe("shouldDecide (phase-1)", () => {
  it("üres eseménylistára azonnal false-t ad (LLM hívás nélkül)", async () => {
    const result = await shouldDecide([]);
    expect(result.shouldDecide).toBe(false);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("ha a LLM mond érdemeset, továbbadja", async () => {
    (chatJson as any).mockResolvedValue({
      data: { shouldDecide: true, summary: "ETF hír jött", notableEvents: [{ symbol: "BTC", reason: "big inflow" }] },
      raw: "",
    });
    const events: DataPoint[] = [
      { source: "cryptopanic", symbol: "BTC", timestamp: 1, kind: "news", news: { title: "ETF", url: "x", sentiment: "bullish" } },
    ];
    const result = await shouldDecide(events);
    expect(result.shouldDecide).toBe(true);
    expect(result.notableEvents).toHaveLength(1);
  });

  it("LLM hiba (fallback) esetén false-t ad", async () => {
    (chatJson as any).mockResolvedValue({
      data: { shouldDecide: false, summary: "LLM hiba, HOLD.", notableEvents: [] },
      raw: "",
    });
    const result = await shouldDecide([
      { source: "coingecko", symbol: "BTC", timestamp: 1, kind: "price", price: { usd: 60000, volume24h: 1, change24hPct: 0 } },
    ]);
    expect(result.shouldDecide).toBe(false);
  });
});

describe("shouldDecide — a hívás mérhető adatai nem vesznek el", () => {
  it("továbbadja az LLM usage-t, hogy a tick health láthassa a hibát", async () => {
    (chatJson as any).mockResolvedValue({
      data: { shouldDecide: false, summary: "LLM hiba, HOLD.", notableEvents: [] },
      raw: "",
      usage: { model: "glm-4-flash", promptVersion: "p1", latencyMs: 75123, failed: true, errorCode: "timeout" },
    });
    const r = await shouldDecide([
      { source: "coingecko", symbol: "BTC", timestamp: 1, kind: "price", price: { usd: 1, volume24h: 1, change24hPct: 0 } },
    ]);
    expect(r.usage?.failed).toBe(true);
    expect(r.usage?.errorCode).toBe("timeout");
  });

  it("hívás nélküli ágon a usage null, nem kitalált érték", async () => {
    const r = await shouldDecide([]);
    expect(r.usage).toBeNull();
  });
});

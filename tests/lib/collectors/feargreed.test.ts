import { describe, it, expect, vi, beforeEach } from "vitest";
import { FearGreedCollector } from "@/lib/collectors/feargreed";

describe("FearGreedCollector", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("a Fear & Greed indexet sentiment DataPoint-tá alakítja", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ value: "27", value_classification: "Fear", timestamp: "123" }],
      }),
    });
    const r = await new FearGreedCollector().collect();
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("sentiment");
    expect(r[0].symbol).toBe("CRYPTO");
    expect(r[0].sentiment).toEqual({ value: 27, classification: "Fear" });
  });

  it("API hiba esetén üres listát ad (nem dob)", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 500 });
    const r = await new FearGreedCollector().collect();
    expect(r).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { predict } from "@/lib/ml/predictor";
import type { MlFeatures } from "@/lib/ml/features";

const feat = (over: Partial<MlFeatures> = {}): MlFeatures => ({
  symbol: "BTC",
  return1h: 0.01,
  return4h: 0.02,
  volatility4h: 0.015,
  volumeRatio: 1.2,
  ...over,
});

describe("predict (betanított logreg modell)", () => {
  it("üres bemenetre üres jelet ad", async () => {
    expect(await predict([])).toEqual([]);
  });

  it("érvényes MlSignal-t ad (irány + 0..1 konfidencia)", async () => {
    const [s] = await predict([feat()]);
    expect(s.symbol).toBe("BTC");
    expect(["up", "down", "flat"]).toContain(s.direction1h);
    expect(s.confidence).toBeGreaterThanOrEqual(0);
    expect(s.confidence).toBeLessThanOrEqual(1);
    expect(s.volatilityPct).toBeCloseTo(1.5, 6); // 0.015 * 100
  });

  it("a tanult mean-reversion: erősen pozitív return inkább 'down', erősen negatív inkább 'up'", async () => {
    const [up] = await predict([feat({ return1h: 0.08, return4h: 0.12 })]);
    const [down] = await predict([feat({ return1h: -0.08, return4h: -0.12 })]);
    expect(up.direction1h).toBe("down");
    expect(down.direction1h).toBe("up");
  });
});

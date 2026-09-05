import { describe, it, expect } from "vitest";
import { predict, predictWithStatus, modelStatus, evaluatePromotion } from "@/lib/ml/predictor";
import { FEATURE_NAMES, FEATURE_VERSION, type MlFeatures } from "@/lib/ml/features";

const feat = (over: Partial<MlFeatures> = {}): MlFeatures => ({
  symbol: "BTC",
  return1h: 0.01,
  return4h: 0.02,
  volatility4h: 0.015,
  volumeRatio: 1.2,
  featureVersion: FEATURE_VERSION,
  asOf: 1_700_000_000_000,
  timeframe: "1h",
  ...over,
});

/** Egy érvényes, a jelenlegi feature-verzióhoz tartozó modellartefaktum. */
const goodModel = {
  type: "logreg",
  features: [...FEATURE_NAMES],
  featureVersion: FEATURE_VERSION,
  // Negatív súlyok: a tanult mean-reversion (erős emelkedés után inkább lefelé).
  weights: [-0.5, -0.6, -0.05, -0.01],
  bias: 0,
  mean: [0, 0, 0, 1],
  std: [0.01, 0.02, 0.003, 0.8],
  trainedAtMs: 1_700_000_000_000,
  metrics: { testAuc: 0.55, testAcc: 0.54, testBaseUp: 0.5 },
};

describe("modelStatus — a modell és a feature-verzió összetartozik", () => {
  it("érvényes artefaktum használható", () => {
    const s = modelStatus(goodModel);
    expect(s.usable).toBe(true);
  });

  it("AUDIT §5: eltérő feature-verzió KARANTÉN, nem néma továbbhasználat", () => {
    const s = modelStatus({ ...goodModel, featureVersion: "f1-regi" });
    expect(s.usable).toBe(false);
    expect(s.usable === false && s.reason).toBe("feature_version_mismatch");
  });

  it("hiányzó feature-verzió (a régi artefaktumok) szintén karantén", () => {
    const { featureVersion, ...withoutVersion } = goodModel;
    expect(modelStatus(withoutVersion).usable).toBe(false);
  });

  it("eltérő feature-sorrend elutasításra kerül", () => {
    const s = modelStatus({ ...goodModel, features: ["return4h", "return1h", "volatility4h", "volumeRatio"] });
    expect(s.usable === false && s.reason).toBe("feature_order_mismatch");
  });

  it("hiányzó modell felismerhető", () => {
    expect(modelStatus({}).usable).toBe(false);
  });

  it("rossz vektorhossz elutasításra kerül", () => {
    const s = modelStatus({ ...goodModel, mean: [0, 0] });
    expect(s.usable === false && s.reason).toBe("shape_mismatch");
  });
});

describe("predictWithStatus", () => {
  it("üres bemenetre üres jelet ad", async () => {
    expect(predictWithStatus([], goodModel).signals).toEqual([]);
  });

  it("érvényes MlSignal-t ad (irány + 0..1 konfidencia)", () => {
    const [s] = predictWithStatus([feat()], goodModel).signals;
    expect(s.symbol).toBe("BTC");
    expect(["up", "down", "flat"]).toContain(s.direction1h);
    expect(s.confidence).toBeGreaterThanOrEqual(0);
    expect(s.confidence).toBeLessThanOrEqual(1);
    expect(s.volatilityPct).toBeCloseTo(1.5, 6);
    // A jel a FELHASZNÁLT ADAT idejéhez tartozik.
    expect(s.timestamp).toBe(1_700_000_000_000);
  });

  it("a tanult mean-reversion: erősen pozitív return inkább 'down', erősen negatív inkább 'up'", () => {
    const [up] = predictWithStatus([feat({ return1h: 0.08, return4h: 0.12 })], goodModel).signals;
    const [down] = predictWithStatus([feat({ return1h: -0.08, return4h: -0.12 })], goodModel).signals;
    expect(up.direction1h).toBe("down");
    expect(down.direction1h).toBe("up");
  });

  it("inkompatibilis modell mellett NINCS jel (nem naiv heurisztika)", () => {
    const r = predictWithStatus([feat()], { ...goodModel, featureVersion: "regi" });
    expect(r.signals).toEqual([]);
    expect(r.status.usable).toBe(false);
  });

  it("eltérő feature-verziójú feature-t kihagy", () => {
    const r = predictWithStatus([feat({ featureVersion: "masik" })], goodModel);
    expect(r.signals).toEqual([]);
  });

  it("a jelenlegi AKTÍV modell a régi feature-készlethez készült → karanténban van", async () => {
    // Ez szándékos: a régi model.json a kevert volumenű, elemszám-alapú feature-ökre
    // tanult. Amíg nincs újratanítás a v2 feature-ökkel, nincs ML-jel.
    expect(await predict([feat()])).toEqual([]);
  });
});

describe("evaluatePromotion — az AUC ≥ 0,5 önmagában NEM kapu", () => {
  const active = { metrics: { testAuc: 0.5 } };

  it("a 0,5 körüli AUC-t elutasítja (az csak a véletlen szintje)", () => {
    const g = evaluatePromotion(
      { metrics: { testAuc: 0.505, testAcc: 0.51, testBaseUp: 0.5 }, samples: { test: 3000 } },
      active,
    );
    expect(g.promote).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/AUC/);
  });

  it("kevés teszt-mintát elutasít", () => {
    const g = evaluatePromotion(
      { metrics: { testAuc: 0.6, testAcc: 0.58, testBaseUp: 0.5 }, samples: { test: 100 } },
      active,
    );
    expect(g.promote).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/minta/);
  });

  it("a többségi alapvonalat alig verő pontosságot elutasítja", () => {
    const g = evaluatePromotion(
      { metrics: { testAuc: 0.6, testAcc: 0.52, testBaseUp: 0.52 }, samples: { test: 3000 } },
      active,
    );
    expect(g.promote).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/alapvonal/);
  });

  it("az aktív modellhez képest nem javuló jelöltet elutasítja", () => {
    const g = evaluatePromotion(
      { metrics: { testAuc: 0.56, testAcc: 0.56, testBaseUp: 0.5 }, samples: { test: 3000 } },
      { metrics: { testAuc: 0.56 } },
    );
    expect(g.promote).toBe(false);
  });

  it("minden feltétel teljesülésekor léptethető", () => {
    const g = evaluatePromotion(
      { metrics: { testAuc: 0.58, testAcc: 0.56, testBaseUp: 0.5 }, samples: { test: 3000 } },
      active,
    );
    expect(g.promote).toBe(true);
    expect(g.reasons).toEqual([]);
  });
});

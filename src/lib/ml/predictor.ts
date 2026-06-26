import type { MlSignal } from "@/lib/types";
import type { MlFeatures } from "./features";
import model from "./model.json";

/**
 * ML prediktor — a `scripts/train-model.ts` által Binance-történelmen betanított
 * logisztikus regressziót futtatja (a model.json a repóban van, így a Vercel
 * bundle-be kerül — nincs natív dep / külső artifact). A 4 feature standardizálva,
 * majd sigmoid(w·x + b) → P(next-hour up). Lásd spec §3.2 + src/lib/ml/README.md.
 *
 * Ha a model.json hiányos/sérült, naiv heurisztikára esik vissza (sosem omlik össze).
 */
const W = (model as { weights?: number[] }).weights ?? [];
const B = (model as { bias?: number }).bias ?? 0;
const MEAN = (model as { mean?: number[] }).mean ?? [];
const STD = (model as { std?: number[] }).std ?? [];
const HAS_MODEL = W.length === 4 && MEAN.length === 4 && STD.length === 4;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function probUp(f: MlFeatures): number {
  const x = [f.return1h, f.return4h, f.volatility4h, f.volumeRatio];
  let z = B;
  for (let j = 0; j < 4; j++) z += W[j] * ((x[j] - MEAN[j]) / (STD[j] || 1));
  return sigmoid(z);
}

export async function predict(features: MlFeatures[]): Promise<MlSignal[]> {
  const ts = Date.now();
  return features.map((f) => {
    if (HAS_MODEL) {
      const p = probUp(f);
      const confidence = Math.min(1, Math.abs(p - 0.5) * 2);
      const direction1h = confidence < 0.02 ? "flat" : p >= 0.5 ? "up" : "down";
      return { symbol: f.symbol, timestamp: ts, direction1h, confidence, volatilityPct: f.volatility4h * 100 };
    }
    // Fallback: naiv heurisztika, ha nincs betanított modell.
    const direction1h =
      f.return1h > 0 && f.volatility4h < 0.02 ? "up" : f.return1h < -0.001 ? "down" : "flat";
    return {
      symbol: f.symbol,
      timestamp: ts,
      direction1h,
      confidence: Math.min(0.7, 0.5 + Math.abs(f.return1h) * 10),
      volatilityPct: f.volatility4h * 100,
    };
  });
}

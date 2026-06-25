import type { MlSignal } from "@/lib/types";
import type { MlFeatures } from "./features";

/**
 * LightGBM prediktor váza. A betanított modell artifact (JSON) a Vercel
 * Blob Storage-ban van (a repo-ban NEM — lásd spec §3.2 self-review javítás).
 *
 * Mivel a Vercel szerverless nem futtat natív LightGBM-et jól, a gyakorlatban
 * a predikciót vagy (a) egy kompilált ONNX modell futtatja, vagy (b) a
 * betanított súlyokat egy egyszerű tree-walk implementálja TypeScript-ben.
 *
 * AMÍG A MODELL NINCS BETANÍTVA (demo-fázis), egy naiv heurisztika ad jelet:
 * pozitív 1h return + alacsony volatilitás → "up", erősen negatív → "down",
 * egyébként "flat". Ez elegendő az AI lánc teszteléséhez. Lásd README.md.
 */
export async function predict(features: MlFeatures[]): Promise<MlSignal[]> {
  const ts = Date.now();
  return features.map((f) => {
    const direction1h =
      f.return1h > 0 && f.volatility4h < 0.02
        ? "up"
        : f.return1h < -0.001
          ? "down"
          : "flat";
    return {
      symbol: f.symbol,
      timestamp: ts,
      direction1h,
      confidence: Math.min(0.7, 0.5 + Math.abs(f.return1h) * 10),
      volatilityPct: f.volatility4h * 100,
    };
  });
}

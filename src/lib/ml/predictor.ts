import type { MlSignal } from "@/lib/types";
import { FEATURE_NAMES, FEATURE_VERSION, featureVector, type MlFeatures } from "./features";
import model from "./model.json";

/**
 * ML prediktor (T13) — a betanított logisztikus regressziót futtatja.
 *
 * KULCSSZABÁLY: a modellartefaktum és a feature-verzió ÖSSZETARTOZIK. Ha az aktív modell
 * más feature-verzióhoz vagy más feature-sorrendhez készült, NINCS ML-jel — a régi modellt
 * tilos új jelentésű feature-ökkel tovább használni (audit §5). A korábbi „naiv
 * heurisztika" fallback megszűnt: az nem ML-jel volt, csak annak látszott.
 */
interface ModelArtifact {
  type?: string;
  features?: string[];
  featureVersion?: string;
  weights?: number[];
  bias?: number;
  mean?: number[];
  std?: number[];
  trainedAtMs?: number;
  metrics?: { testAuc?: number; testAcc?: number; testBaseUp?: number };
}

const ARTIFACT = model as ModelArtifact;

export type ModelStatus =
  | { usable: true; featureVersion: string; trainedAtMs: number | null }
  | { usable: false; reason: "missing" | "feature_version_mismatch" | "feature_order_mismatch" | "shape_mismatch"; detail: string };

/** Az aktív modell használhatóságának ELLENŐRZÖTT állapota. */
export function modelStatus(artifact: ModelArtifact = ARTIFACT): ModelStatus {
  const w = artifact.weights ?? [];
  const mean = artifact.mean ?? [];
  const std = artifact.std ?? [];
  if (w.length === 0) {
    return { usable: false, reason: "missing", detail: "Nincs betanított modell (üres súlyvektor)." };
  }
  if (artifact.featureVersion !== FEATURE_VERSION) {
    return {
      usable: false,
      reason: "feature_version_mismatch",
      detail: `A modell feature-verziója ${artifact.featureVersion ?? "ismeretlen"}, a futó kódé ${FEATURE_VERSION}. KARANTÉN: nincs ML-jel.`,
    };
  }
  const names = artifact.features ?? [];
  if (names.length !== FEATURE_NAMES.length || names.some((n, i) => n !== FEATURE_NAMES[i])) {
    return {
      usable: false,
      reason: "feature_order_mismatch",
      detail: `A modell feature-sorrendje (${names.join(",")}) nem egyezik a kódéval (${FEATURE_NAMES.join(",")}).`,
    };
  }
  if (w.length !== FEATURE_NAMES.length || mean.length !== w.length || std.length !== w.length) {
    return { usable: false, reason: "shape_mismatch", detail: "A súly/átlag/szórás vektorok hossza nem egyezik." };
  }
  return { usable: true, featureVersion: FEATURE_VERSION, trainedAtMs: artifact.trainedAtMs ?? null };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function probUp(f: MlFeatures, artifact: ModelArtifact): number {
  const x = featureVector(f);
  const w = artifact.weights!;
  const mean = artifact.mean!;
  const std = artifact.std!;
  let z = artifact.bias ?? 0;
  for (let j = 0; j < w.length; j++) z += w[j] * ((x[j] - mean[j]) / (std[j] || 1));
  return sigmoid(z);
}

export interface PredictResult {
  signals: MlSignal[];
  status: ModelStatus;
}

/**
 * Előrejelzés. Használhatatlan modell esetén ÜRES jel-lista és a `status`-ban az ok —
 * a hívó (és a napló) így tudja, hogy nem volt ML-bemenet, nem pedig „semleges" jel volt.
 */
export function predictWithStatus(features: MlFeatures[], artifact: ModelArtifact = ARTIFACT): PredictResult {
  const status = modelStatus(artifact);
  if (!status.usable) return { signals: [], status };

  const signals = features
    .filter((f) => f.featureVersion === FEATURE_VERSION)
    .map((f) => {
      const p = probUp(f, artifact);
      const confidence = Math.min(1, Math.abs(p - 0.5) * 2);
      const direction1h: MlSignal["direction1h"] = confidence < 0.02 ? "flat" : p >= 0.5 ? "up" : "down";
      return {
        symbol: f.symbol,
        // A jel a FELHASZNÁLT ADAT idejéhez tartozik, nem a hívás pillanatához.
        timestamp: f.asOf,
        direction1h,
        confidence,
        volatilityPct: f.volatility4h * 100,
      };
    });
  return { signals, status };
}

/** Visszafelé kompatibilis alak. */
export async function predict(features: MlFeatures[]): Promise<MlSignal[]> {
  return predictWithStatus(features).signals;
}

/**
 * A modell minőségi kapuja. Az AUC ≥ 0,5 önmagában NEM elég a cseréhez: az „nem rosszabb
 * a véletlennél" küszöb, nem bizonyított előny. A csere feltételei együtt értendők.
 */
export interface PromotionGate {
  promote: boolean;
  reasons: string[];
}

export function evaluatePromotion(
  candidate: { metrics?: { testAuc?: number; testAcc?: number; testBaseUp?: number }; samples?: { test?: number } },
  active: { metrics?: { testAuc?: number } } = ARTIFACT,
  params: { minAuc?: number; minEdgeOverBaseline?: number; minTestSamples?: number; minAucImprovement?: number } = {},
): PromotionGate {
  const minAuc = params.minAuc ?? 0.53;
  const minEdge = params.minEdgeOverBaseline ?? 0.01;
  const minSamples = params.minTestSamples ?? 1000;
  const minImprovement = params.minAucImprovement ?? 0.005;

  const reasons: string[] = [];
  const auc = candidate.metrics?.testAuc ?? 0;
  const acc = candidate.metrics?.testAcc ?? 0;
  const base = candidate.metrics?.testBaseUp ?? 0.5;
  const n = candidate.samples?.test ?? 0;
  const activeAuc = active.metrics?.testAuc ?? 0;

  if (n < minSamples) reasons.push(`Túl kevés teszt-minta (${n} < ${minSamples}).`);
  if (auc < minAuc) reasons.push(`A teszt AUC ${auc.toFixed(3)} a ${minAuc} küszöb alatt (a 0,5 csak a véletlen szintje).`);
  if (acc - Math.max(base, 1 - base) < minEdge) {
    reasons.push(
      `A pontosság (${acc.toFixed(3)}) nem elég a többségi alapvonal (${Math.max(base, 1 - base).toFixed(3)}) fölött.`,
    );
  }
  if (auc - activeAuc < minImprovement) {
    reasons.push(`Az AUC nem javul eleget az aktív modellhez képest (${auc.toFixed(3)} vs ${activeAuc.toFixed(3)}).`);
  }
  return { promote: reasons.length === 0, reasons };
}

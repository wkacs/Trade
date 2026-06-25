import type { DataPoint, MlSignal } from "@/lib/types";
import { chatJson } from "./client";
import { Phase2ResultSchema, type Phase2Result } from "./schemas";

const SYSTEM = `Te egy hibrid AI kereskedési döntéshozó vagy (GLM-5.2).
Kapsz: híreket + sentiment, whale-mozgásokat, ML ár-előrejelzéseket,
és a jelenlegi portfóliót. A feladat: hozz EGY döntést a következő órára.
Szabályok: csak BTC/ETH/SOL, amountPct 0..0.2 (max 20% tőke),
konfidenciát 0..1-ben adj. A reasoning kötelező, magyarul, tömören.
Csak JSON-t adj.`;

export interface DecideInput {
  events: DataPoint[];
  mlSignals: MlSignal[];
  portfolio: {
    cashUsd: number;
    positions: { symbol: string; qty: number; entryPrice: number }[];
  };
}

/**
 * Phase-2: GLM-5.2 — csak ha a phase-1 jelezte, hogy érdemes dönteni.
 * Strukturált JSON-t ad vissza érveléssel. Lásd spec §3.2.
 */
export async function decide(input: DecideInput): Promise<Phase2Result> {
  const fallback: Phase2Result = {
    action: "HOLD",
    amountPct: 0,
    confidence: 0.3,
    reasoning: "LLM hiba, HOLD.",
  };
  const user = JSON.stringify({
    events: input.events,
    ml: input.mlSignals,
    portfolio: input.portfolio,
    limits: { maxPositionPct: 0.2, maxConcurrent: 3 },
  });
  const { data } = await chatJson<Phase2Result>(
    process.env.LLM_MODEL_PHASE2 ?? "glm-5.2",
    SYSTEM,
    user,
    fallback,
  );
  return Phase2ResultSchema.parse(data);
}

import type { DataPoint, MlSignal } from "@/lib/types";
import { chatJson } from "./client";
import { Phase2ResultSchema, type Phase2Result } from "./schemas";

const SYSTEM = `Te egy hibrid AI kereskedési döntéshozó vagy.
Kapsz: híreket + sentiment, whale-mozgásokat, ML ár-előrejelzéseket,
és a jelenlegi portfóliót. A feladat: hozz EGY döntést a következő órára.

Válaszolj KIZÁRÓLAG ezzel a JSON-objektummal, pontosan ezekkel a mezőnevekkel,
semmilyen extra szöveg vagy mező nélkül:
{
  "action": "BUY" vagy "SELL" vagy "HOLD",
  "symbol": "BTC" vagy "ETH" vagy "SOL",
  "amountPct": szám 0 és 0.2 között (a tőke hányada),
  "confidence": szám 0 és 1 között,
  "reasoning": "kötelező, magyarul, tömör indoklás"
}
Szabályok: csak BTC/ETH/SOL; amountPct max 0.2 (20% tőke); ha nincs jó setup,
action="HOLD" (ekkor a symbol lehet üres). A reasoning mindig kötelező.`;

export interface DecideInput {
  events: DataPoint[];
  mlSignals: MlSignal[];
  portfolio: {
    cashUsd: number;
    positions: { symbol: string; qty: number; entryPrice: number }[];
  };
  /** A korábbi döntések utólagos eredménye („bejött volna?") — visszacsatolás az AI-nak. */
  performance?: {
    actionable: number;
    hitRate: number | null;
    avgHypotheticalPnlPct: number;
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
    // Visszacsatolás: a korábbi döntéseid szándéka hány %-ban lett volna nyereséges
    // (hitRate) és átlagosan mennyit hozott/vitt (avgHypotheticalPnlPct). Tanulj belőle,
    // de a JELEN adat a döntő. null hitRate = még nincs elég kiértékelt döntés.
    recentPerformance: input.performance ?? null,
  });
  const { data, raw } = await chatJson<Phase2Result>(
    process.env.LLM_MODEL_PHASE2 ?? "glm-5.2",
    SYSTEM,
    user,
    fallback,
  );
  // Robusztus: rossz alakú JSON → HOLD fallback, nem dobás (spec §6).
  const parsed = Phase2ResultSchema.safeParse(data);
  if (!parsed.success) {
    console.warn("[phase2] séma-eltérés → HOLD. Nyers kimenet:", raw.slice(0, 200));
    return fallback;
  }
  return parsed.data;
}

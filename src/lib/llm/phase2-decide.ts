import type { DataPoint, MlSignal } from "@/lib/types";
import { chatJson, DEFAULT_LLM_TIMEOUT_MS, type LlmUsage } from "./client";
import { normalizePhase2, HOLD_DECISION, DECISION_SCHEMA_VERSION, type Phase2Decision } from "./schemas";

/** A prompt verziója — MINDEN naplózott döntés ezzel visszavezethető az utasításra. */
export const PHASE2_PROMPT_VERSION = "p2-v2-2026-09-05";

const SYSTEM = `Te egy hibrid AI kereskedési döntéshozó vagy.
Kapsz: híreket + sentimentet, ML ár-előrejelzéseket, és a jelenlegi portfóliót a
VALÓS belépési árakkal, pozícióértékekkel és a ténylegesen szabad kerettel.
A feladat: hozz EGY döntést a következő órára.

FONTOS szemlélet: az extrém piaci félelem klasszikus HALMOZÁSI ablak — ilyenkor a
megfontolt BUY gyakran jobb, mint a reflexszerű HOLD. Ne torzítsd a félelmet
automatikusan HOLD felé; mérlegelj tényszerűen vétel mellett is.

A MÉRET JELENTÉSE OLDALANKÉNT KÜLÖNBÖZŐ:
  - BUY  → "equityFraction": a TELJES EQUITY hányada (0..1)
  - SELL → "positionFraction": a BIRTOKOLT MENNYISÉG hányada (0..1)
Eladásnál tehát NEM a készpénzhez viszonyítasz: nulla készpénz mellett is eladhatod a
pozíció 100%-át.

Válaszolj KIZÁRÓLAG ezzel a JSON-objektummal, pontosan ezekkel a mezőnevekkel,
semmilyen extra szöveg vagy mező nélkül:
{
  "action": "BUY" vagy "SELL" vagy "HOLD",
  "symbol": a kosárban szereplő szimbólum,
  "equityFraction": szám 0 és 1 között (CSAK BUY-nál),
  "positionFraction": szám 0 és 1 között (CSAK SELL-nél),
  "confidence": szám 0 és 1 között,
  "reasoning": "kötelező, magyarul, tömör indoklás"
}
Szabályok: csak a megadott kosár coinjai; SELL csak birtokolt coinra; ha nincs jó setup,
action="HOLD" (ekkor a symbol lehet üres). A reasoning mindig kötelező.
A "confidence" a SAJÁT bizonytalanságod jelzése, NEM kalibrált találati valószínűség.`;

export interface PortfolioContextPosition {
  symbol: string;
  qty: number;
  /** A VALÓS átlagos belépési ár. A régi kód itt 0-t küldött (audit C. szakasz). */
  entryPrice: number;
  /** A pozíció aktuális, mark-to-market értéke. */
  valueUsd: number;
  /** Nem realizált eredmény százalékban. */
  unrealizedPnlPct: number | null;
  stopPrice: number | null;
}

export interface DecideInput {
  events: DataPoint[];
  mlSignals: MlSignal[];
  portfolio: {
    cashUsd: number;
    equityUsd: number;
    positions: PortfolioContextPosition[];
    /** Szimbólumonként ténylegesen szabad vételi keret USD-ben (a kockázati kapuból). */
    freeBuyBudgetUsd: Record<string, number>;
  };
  /** Az engedélyezett kosár. A kosáron kívüli javaslat HOLD lesz. */
  allowedSymbols: string[];
  /** Adatminőség: mire NEM támaszkodhat az AI. */
  dataQuality?: {
    mlUsable: boolean;
    staleOrMissingQuotes: string[];
    insufficientHistory: string[];
  };
  /**
   * A korábbi döntések utólagos IRÁNY-diagnosztikája — visszacsatolás.
   * FIGYELEM (T20): ez iránytalálat, NEM realizált profit, és nem is annak becslése.
   */
  performance?: {
    actionable: number;
    directionHitRate: number | null;
    avgDirectionalScorePct: number;
  };
  timeoutMs?: number;
}

export interface DecideResult {
  decision: Phase2Decision;
  usage: LlmUsage;
  /** A modellnek ténylegesen elküldött kontextus mérete (naplózáshoz). */
  promptChars: number;
}

/**
 * Phase-2 (T16) — csak ha a phase-1 jelezte, hogy érdemes dönteni.
 *
 * Amit javít az audit C. szakaszához képest:
 *  - az AI VALÓS belépési árat, pozícióértéket, equityt és szabad keretet lát;
 *  - a méret jelentése oldalanként külön mező, ezért cash≈0 mellett is tud eladni;
 *  - a kosáron kívüli vagy nem birtokolt szimbólum HOLD lesz, nem hibás order;
 *  - a hívás időkorlátos, és a token- és időadat naplózható;
 *  - a `confidence` sehol nem használatos találati valószínűségként.
 */
export async function decide(input: DecideInput): Promise<DecideResult> {
  const heldSymbols = input.portfolio.positions.filter((p) => p.qty > 0).map((p) => p.symbol);
  const user = JSON.stringify({
    schemaVersion: DECISION_SCHEMA_VERSION,
    events: input.events,
    ml: input.mlSignals,
    portfolio: {
      cashUsd: input.portfolio.cashUsd,
      equityUsd: input.portfolio.equityUsd,
      positions: input.portfolio.positions,
      freeBuyBudgetUsd: input.portfolio.freeBuyBudgetUsd,
    },
    allowedSymbols: input.allowedSymbols,
    heldSymbols,
    dataQuality: input.dataQuality ?? null,
    // Visszacsatolás: a korábbi döntéseid szándéka hány %-ban lett volna nyereséges.
    // null hitRate = még nincs elég kiértékelt döntés.
    recentPerformance: input.performance ?? null,
  });

  const model = process.env.LLM_MODEL_PHASE2 ?? "glm-5.2";
  const { data, raw, usage } = await chatJson<unknown>(model, SYSTEM, user, null, {
    timeoutMs: input.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    promptVersion: PHASE2_PROMPT_VERSION,
  });

  if (usage.failed || data === null) {
    return {
      decision: HOLD_DECISION(
        `LLM hiba (${usage.errorCode ?? "ismeretlen"}), HOLD.`,
        usage.errorMessage ? [usage.errorMessage] : [],
      ),
      usage,
      promptChars: user.length,
    };
  }

  const decision = normalizePhase2(data, { allowedSymbols: input.allowedSymbols, heldSymbols });
  if (decision.adjustments.length > 0) {
    console.warn(`[phase2] a válasz normalizálva: ${decision.adjustments.join("; ")} | nyers: ${raw.slice(0, 200)}`);
  }
  return { decision, usage, promptChars: user.length };
}

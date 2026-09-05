import { z } from "zod";

/** Phase-1 kimenet: érdemes-e egyáltalán döntést hozni? */
export const Phase1ResultSchema = z.object({
  shouldDecide: z.boolean(),
  summary: z.string(),
  notableEvents: z
    .array(
      z.object({
        symbol: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
});
export type Phase1Result = z.infer<typeof Phase1ResultSchema>;

/**
 * A döntési séma verziója (T16). A régi naplókat NEM szabad az új jelentéssel
 * újraértelmezni: a v1 `amountPct` BUY-nál a KÉSZPÉNZ hányada volt, SELL-nél szintén —
 * ezért nem tudott érdemben eladni, ha a tőke pozícióban állt (audit §2).
 */
export const DECISION_SCHEMA_VERSION = 2 as const;

/**
 * Phase-2 kimenet v2 — a méret jelentése OLDALANKÉNT külön mező:
 *   BUY  → `equityFraction`   (a TELJES EQUITY hányada)
 *   SELL → `positionFraction` (a BIRTOKOLT MENNYISÉG hányada)
 */
export const Phase2ResultSchemaV2 = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  symbol: z.string().optional(),
  equityFraction: z.number().min(0).max(1).optional(),
  positionFraction: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
});
export type Phase2ResultV2 = z.infer<typeof Phase2ResultSchemaV2>;

/** A régi (v1) alak — csak az adapter és a régi naplók olvasásához. */
export const Phase2ResultSchemaV1 = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  symbol: z.string().optional(),
  amountPct: z.number().min(0).max(1).default(0),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type Phase2ResultV1 = z.infer<typeof Phase2ResultSchemaV1>;

/** A normalizált, verziózott döntés — a motor ezt kapja. */
export interface Phase2Decision {
  schemaVersion: typeof DECISION_SCHEMA_VERSION;
  action: "BUY" | "SELL" | "HOLD";
  symbol: string | null;
  /** BUY: a teljes equity hányada. HOLD/SELL esetén 0. */
  equityFraction: number;
  /** SELL: a birtokolt mennyiség hányada. HOLD/BUY esetén 0. */
  positionFraction: number;
  /**
   * A modell önbizalma. FIGYELEM: ez NEM kalibrált találati valószínűség, és a rendszer
   * sehol nem használja annak. Csak naplózásra és emberi olvasásra való.
   */
  confidence: number;
  reasoning: string;
  /** Ha a válaszból normalizálni kellett, itt látszik, miért. */
  adjustments: string[];
}

export const HOLD_DECISION = (reasoning: string, adjustments: string[] = []): Phase2Decision => ({
  schemaVersion: DECISION_SCHEMA_VERSION,
  action: "HOLD",
  symbol: null,
  equityFraction: 0,
  positionFraction: 0,
  confidence: 0.3,
  reasoning,
  adjustments,
});

export interface NormalizeContext {
  /** Az engedélyezett szimbólumok (a kosár). */
  allowedSymbols: string[];
  /** A ténylegesen BIRTOKOLT szimbólumok — SELL csak ezekre értelmes. */
  heldSymbols: string[];
}

/**
 * Nyers LLM-válasz → verziózott döntés. Elfogadja a v2 és a régi v1 alakot is; az utóbbit
 * EXPLICIT adapterrel fordítja, és a fordítás ténye látszik az `adjustments` listában.
 *
 * Minden nem értelmezhető vagy nem engedélyezett kimenet HOLD lesz, indoklással — nem
 * dobunk, mert az LLM válasza nem megbízható bemenet.
 */
export function normalizePhase2(raw: unknown, ctx: NormalizeContext): Phase2Decision {
  const adjustments: string[] = [];

  const v2 = Phase2ResultSchemaV2.safeParse(raw);
  let action: "BUY" | "SELL" | "HOLD";
  let symbol: string | null;
  let equityFraction = 0;
  let positionFraction = 0;
  let confidence: number;
  let reasoning: string;

  if (v2.success && (v2.data.equityFraction !== undefined || v2.data.positionFraction !== undefined || v2.data.action === "HOLD")) {
    action = v2.data.action;
    symbol = v2.data.symbol ?? null;
    equityFraction = v2.data.equityFraction ?? 0;
    positionFraction = v2.data.positionFraction ?? 0;
    confidence = v2.data.confidence;
    reasoning = v2.data.reasoning;
  } else {
    const v1 = Phase2ResultSchemaV1.safeParse(raw);
    if (!v1.success) {
      return HOLD_DECISION("Az LLM válasza nem felel meg egyik ismert sémának sem — HOLD.", [
        `séma-hiba: ${v1.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      ]);
    }
    action = v1.data.action;
    symbol = v1.data.symbol ?? null;
    confidence = v1.data.confidence;
    reasoning = v1.data.reasoning;
    // v1 → v2 adapter: az `amountPct` jelentése oldalanként más lesz.
    if (action === "BUY") equityFraction = v1.data.amountPct;
    if (action === "SELL") positionFraction = v1.data.amountPct;
    adjustments.push("v1 válasz-alak: az amountPct oldalanként lett értelmezve (BUY=equity, SELL=pozíció).");
  }

  if (action === "HOLD") {
    return { schemaVersion: DECISION_SCHEMA_VERSION, action: "HOLD", symbol: null, equityFraction: 0, positionFraction: 0, confidence, reasoning, adjustments };
  }

  if (!symbol) {
    return HOLD_DECISION(`${reasoning} (HOLD: az LLM nem adott szimbólumot.)`, [...adjustments, "hiányzó symbol"]);
  }
  if (!ctx.allowedSymbols.includes(symbol)) {
    return HOLD_DECISION(`${reasoning} (HOLD: a ${symbol} nincs az engedélyezett kosárban.)`, [
      ...adjustments,
      `nem engedélyezett symbol: ${symbol}`,
    ]);
  }
  if (action === "SELL" && !ctx.heldSymbols.includes(symbol)) {
    return HOLD_DECISION(`${reasoning} (HOLD: nincs birtokolt ${symbol} pozíció.)`, [
      ...adjustments,
      `nem birtokolt symbol eladása: ${symbol}`,
    ]);
  }
  if (action === "BUY" && equityFraction <= 0) {
    return HOLD_DECISION(`${reasoning} (HOLD: nulla vételi hányad.)`, [...adjustments, "nulla equityFraction"]);
  }
  if (action === "SELL" && positionFraction <= 0) {
    return HOLD_DECISION(`${reasoning} (HOLD: nulla eladási hányad.)`, [...adjustments, "nulla positionFraction"]);
  }

  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    action,
    symbol,
    equityFraction: action === "BUY" ? equityFraction : 0,
    positionFraction: action === "SELL" ? positionFraction : 0,
    confidence,
    reasoning,
    adjustments,
  };
}

/** @deprecated v1 alak — csak a régi naplók olvasásához. */
export const Phase2ResultSchema = Phase2ResultSchemaV1;
export type Phase2Result = Phase2ResultV1;

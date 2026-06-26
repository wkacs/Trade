import { getDb, schema } from "@/db/client";
import { and, isNull, isNotNull, lt, eq } from "drizzle-orm";

/** Döntéskori pillanatkép (a decisions.ref oszlopban). */
export interface DecisionRef {
  prices: Record<string, number>;
  /** Az AI VALÓDI szándéka a Risk Manager ELŐTT (rawAction) — „mit akart tényleg". */
  intent: "BUY" | "SELL" | "HOLD";
  intentSymbol: string | null;
  intentAmountPct: number;
}

/** Utólagos kiértékelés (a decisions.outcome oszlopban). */
export interface DecisionOutcome {
  horizonHours: number;
  refSymbol: string | null;
  /** A coin árváltozása % a döntés óta. */
  changePct: number;
  /** Mennyit hozott/vitt volna, ha az AI szándéka szerint kereskedik (BUY: +change, SELL: -change). */
  hypotheticalPnlPct: number;
  /** Nyereséges lett volna-e a szándék szerinti kötés? HOLD-nál null (semleges). */
  wouldProfit: boolean | null;
}

/**
 * Pure: egy döntés utólagos pontozása. „Ha tényleg kötött volna, bejött volna-e?"
 * BUY → akkor jó, ha a coin azóta emelkedett; SELL → ha esett. HOLD → semleges
 * (a BTC piaci mozgását rögzítjük infóként).
 */
export function scoreDecision(
  ref: DecisionRef,
  currentPrices: Record<string, number>,
  horizonHours: number,
): DecisionOutcome {
  const sym = ref.intentSymbol;
  if (ref.intent === "HOLD" || !sym || !ref.prices?.[sym] || !currentPrices?.[sym]) {
    const btcRef = ref.prices?.BTC;
    const btcNow = currentPrices?.BTC;
    const marketChange = btcRef && btcNow ? ((btcNow - btcRef) / btcRef) * 100 : 0;
    return { horizonHours, refSymbol: null, changePct: marketChange, hypotheticalPnlPct: 0, wouldProfit: null };
  }
  const refP = ref.prices[sym];
  const nowP = currentPrices[sym];
  const changePct = ((nowP - refP) / refP) * 100;
  const hypotheticalPnlPct = ref.intent === "BUY" ? changePct : -changePct;
  return { horizonHours, refSymbol: sym, changePct, hypotheticalPnlPct, wouldProfit: hypotheticalPnlPct > 0 };
}

/**
 * Kiértékeli a már „beérett" (ref megvan, outcome még nincs, és elég régi) döntéseket
 * az aktuális árakkal. A tick elején/után hívjuk. Best-effort, hiba esetén 0-t ad.
 */
export async function evaluatePending(
  currentPrices: Record<string, number>,
  minAgeMs = 55 * 60 * 1000,
): Promise<{ evaluated: number }> {
  const db = getDb();
  if (!db) return { evaluated: 0 };
  try {
    const cutoff = new Date(Date.now() - minAgeMs);
    const rows = await db
      .select({ id: schema.decisions.id, ts: schema.decisions.ts, ref: schema.decisions.ref })
      .from(schema.decisions)
      .where(
        and(
          isNotNull(schema.decisions.ref),
          isNull(schema.decisions.outcome),
          lt(schema.decisions.ts, cutoff),
        ),
      );
    for (const row of rows) {
      const ref = row.ref as DecisionRef;
      const hours = (Date.now() - new Date(row.ts).getTime()) / 3_600_000;
      const outcome = scoreDecision(ref, currentPrices, Math.round(hours * 100) / 100);
      await db.update(schema.decisions).set({ outcome }).where(eq(schema.decisions.id, row.id));
    }
    return { evaluated: rows.length };
  } catch (e) {
    console.error("[evaluate] evaluatePending hiba:", e);
    return { evaluated: 0 };
  }
}

export interface PerformanceSummary {
  evaluated: number;
  actionable: number;
  hitRate: number | null;
  avgHypotheticalPnlPct: number;
}

/** Összesített „bejött volna?" statisztika a kiértékelt döntésekből (BUY/SELL szándékúak). */
export async function getPerformanceSummary(): Promise<PerformanceSummary> {
  const db = getDb();
  if (!db) return { evaluated: 0, actionable: 0, hitRate: null, avgHypotheticalPnlPct: 0 };
  try {
    const rows = await db
      .select({ outcome: schema.decisions.outcome })
      .from(schema.decisions)
      .where(isNotNull(schema.decisions.outcome));
    const outcomes = rows.map((r) => r.outcome as DecisionOutcome);
    const actionable = outcomes.filter((o) => o.wouldProfit !== null);
    const wins = actionable.filter((o) => o.wouldProfit).length;
    const avg = actionable.length
      ? actionable.reduce((s, o) => s + o.hypotheticalPnlPct, 0) / actionable.length
      : 0;
    return {
      evaluated: outcomes.length,
      actionable: actionable.length,
      hitRate: actionable.length ? wins / actionable.length : null,
      avgHypotheticalPnlPct: avg,
    };
  } catch (e) {
    console.error("[evaluate] getPerformanceSummary hiba:", e);
    return { evaluated: 0, actionable: 0, hitRate: null, avgHypotheticalPnlPct: 0 };
  }
}

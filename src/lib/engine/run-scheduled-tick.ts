import { eq } from "drizzle-orm";
import { runTick } from "@/lib/engine/tick";
import { getDb, schema } from "@/db/client";
import { evaluatePending } from "@/lib/portfolio/evaluate";

/** Az ütemezett tick eredménye — a cron route és a runner-script közös visszaadása. */
export interface ScheduledTickResult {
  ok: boolean;
  tickId: string;
  decisionId?: string;
  action?: string;
  overridden?: boolean;
  hasTrade?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

/** UTC óra-alapú tick id (YYYY-MM-DD-HH). */
export function currentTickId(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}`;
}

/**
 * A teljes ütemezett tick logikája, HTTP/auth NÉLKÜL:
 *   1) idempotencia (tick_id dedup) → ha már volt döntés ebben az órában, skip
 *   2) runTick (a tényleges ciklus)
 *   3) döntés mentése + risk-override naplózás
 *   4) utólagos kiértékelés (evaluatePending)
 *
 * Ezt hívja a Vercel cron route (`/api/cron/tick`) ÉS a GitHub-runner script
 * (`scripts/tick.ts`) is — így a logika EGY forrás, nem driftel.
 *
 * Ops-háttér: a Vercel Hobby `maxDuration = 60s` cold-starton a tick (collectorok +
 * 2 LLM + DB + profit-ciklus) gyakran túllépi → 504 → kimaradt tick. A runner-oldali
 * futásnak nincs 60s limitje, ezért ott megbízhatóbb. Lásd a workflow `tick.yml`-t.
 */
export async function executeScheduledTick(): Promise<ScheduledTickResult> {
  const tickId = currentTickId();
  const db = getDb();

  // 1) Idempotencia: volt már döntés ezzel a tick_id-del?
  if (db) {
    try {
      const existing = await db
        .select({ id: schema.decisions.id })
        .from(schema.decisions)
        .where(eq(schema.decisions.tickId, tickId))
        .limit(1);
      if (existing.length > 0) {
        return { ok: true, skipped: true, tickId, reason: "already_processed" };
      }
    } catch (e) {
      // Ha a dedup query hibázik (pl. még nincs migrálva a tábla), nem akadályozzuk
      // meg a ciklust — csak logolunk.
      console.error("[scheduled-tick] dedup check hiba:", e);
    }
  }

  // 2) A tényleges ciklus
  try {
    const result = await runTick({
      tickId,
      paperMode: process.env.TRADING_MODE !== "live",
    });

    // 3) Döntés mentése
    let decisionId: string | undefined;
    if (db) {
      try {
        const [inserted] = await db
          .insert(schema.decisions)
          .values({
            tickId,
            action: result.decision.action,
            symbol: result.decision.symbol || null,
            amountPct: result.decision.amountPct ?? null,
            confidence: result.decision.confidence,
            reasoning: result.decision.reasoning,
            model: result.decision.model,
            overridden: result.decision.overridden,
            overrideReason: result.decision.overrideReason ?? null,
            // Pillanatkép a későbbi „bejött volna?" kiértékeléshez: árak + az AI VALÓDI
            // szándéka (rawAction, a Risk Manager előtt) — mintha tényleg kötött volna.
            ref: {
              prices: result.prices,
              intent: result.rawAction,
              intentSymbol: result.decision.symbol || null,
              intentAmountPct: result.rawAmountPct,
            },
          })
          .returning();
        decisionId = inserted?.id;

        // Risk override naplózása — ha a Risk Manager módosította/elutasította a döntést.
        if (decisionId && result.decision.overridden) {
          await db.insert(schema.riskOverrides).values({
            decisionId,
            originalAction: result.rawAction,
            originalAmountPct: result.rawAmountPct,
            finalAction: result.decision.action,
            finalAmountPct: result.decision.amountPct ?? 0,
            reason: result.decision.overrideReason ?? "",
          });
        }

        // Utólagos kiértékelés: a már „beérett" (≥~1h) korábbi döntéseket pontozzuk az
        // aktuális árakkal — „bejött volna-e, ha tényleg kötött volna". Best-effort.
        await evaluatePending(result.prices);
      } catch (e) {
        // DB hiba nem akasztja meg a választ — a döntés már megvan.
        console.error("[scheduled-tick] mentés hiba:", e);
      }
    }

    return {
      ok: true,
      tickId,
      decisionId,
      action: result.decision.action,
      overridden: result.decision.overridden,
      hasTrade: !!result.trade,
    };
  } catch (e) {
    console.error("[scheduled-tick] ciklus hiba:", e);
    return { ok: false, tickId, error: String(e) };
  }
}

import { eq } from "drizzle-orm";
import { runTick } from "@/lib/engine/tick";
import { getDb, schema } from "@/db/client";
import { evaluatePending } from "@/lib/portfolio/evaluate";
import { insertTickRun, loadPortfolioState } from "@/lib/portfolio/accounting";
import { pingHeartbeat } from "@/lib/ops/heartbeat";
import { acquireLease, releaseLease, leaseKey, slotId, newOwnerId, SLOT_MS, type Lease } from "@/lib/engine/run-lease";
import { listUnsettledIntents } from "@/lib/execution/order-store";
import { getTradingMode } from "@/lib/config";

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
  /** A megszerzett lease adatai (átláthatóság: ki futott és milyen tokennel). */
  lease?: { key: string; owner: string; fencingToken: number };
  /** Igaz, ha MINDEN mentés sikerült. Hamis mentés mellett nincs siker-heartbeat. */
  persisted?: boolean;
  /** Egyeztetésre váró, ismeretlen állapotú megbízások száma. */
  unsettledIntents?: number;
}

/** UTC óra-alapú tick id (YYYY-MM-DD-HH). */
export function currentTickId(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}`;
}

export interface ScheduledTickOptions {
  now?: () => number;
  owner?: string;
  /** A belépési idősáv hossza. Alapértelmezés: 1 óra. */
  slotMs?: number;
  /** A lease élettartama. Alapértelmezés: az idősáv 95%-a (tartós claim az adott sávra). */
  leaseTtlMs?: number;
  allowNewBuys?: boolean;
}

/**
 * A teljes ütemezett tick logikája, HTTP/auth NÉLKÜL:
 *   1) LEASE az adott belépési idősávra (tartós claim + fencing token)
 *   2) ismeretlen állapotú megbízások ellenőrzése (egyeztetés, nem újraküldés)
 *   3) runTick (a tényleges ciklus)
 *   4) döntés mentése + risk-override naplózás
 *   5) utólagos kiértékelés (evaluatePending)
 *
 * Ezt hívja a Vercel cron route (`/api/cron/tick`) ÉS a runner-script (`scripts/tick.ts`)
 * is — így a logika EGY forrás, nem driftel.
 *
 * A régi „SELECT a decisions táblán" dedup ELTŰNT mint egyetlen védelem: az nem zárt ki
 * két egyidejű futót. A lease igen; a decisions-ellenőrzés másodlagos védelemként marad.
 */
export async function executeScheduledTick(options: ScheduledTickOptions = {}): Promise<ScheduledTickResult> {
  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const tickId = currentTickId(new Date(nowMs));
  const db = getDb();
  const owner = options.owner ?? newOwnerId("tick");
  const slotMs = options.slotMs ?? SLOT_MS.entry;
  const key = leaseKey("entry", slotId(nowMs, slotMs));
  const ttl = options.leaseTtlMs ?? Math.floor(slotMs * 0.95);

  // 1) Tartós claim erre az idősávra. Ha másé, NEM futunk — ez zárja ki a dupla ticket.
  const lease: Lease = await acquireLease(key, owner, ttl);
  if (db && !lease.acquired) {
    return {
      ok: true,
      skipped: true,
      tickId,
      reason: "lease_held",
      lease: { key, owner: lease.heldBy ?? "?", fencingToken: lease.fencingToken },
    };
  }

  // Másodlagos védelem: ebben az órában volt-e már döntés.
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
      console.error("[scheduled-tick] dedup check hiba:", e);
    }
  }

  // 2) Ismeretlen állapotú megbízások: egyeztetés kell, nem új order.
  let unsettled = 0;
  if (db) {
    try {
      const portfolio = await loadPortfolioState();
      if (portfolio) {
        const pending = await listUnsettledIntents({ portfolioId: portfolio.portfolioId, mode: getTradingMode() });
        unsettled = pending.length;
      }
    } catch (e) {
      console.error("[scheduled-tick] nyitott intentek ellenőrzése hiba:", e);
    }
  }
  if (unsettled > 0) {
    // Nem küldünk új azonosítójú ordert egy ismeretlen kimenetelű megbízás mellé.
    await releaseLease(key, owner);
    await pingHeartbeat(false, { errorCode: "unsettled_intents" });
    return {
      ok: false,
      tickId,
      skipped: true,
      reason: "unsettled_intents",
      unsettledIntents: unsettled,
      lease: { key, owner, fencingToken: lease.fencingToken },
      error: `${unsettled} ismeretlen állapotú megbízás vár egyeztetésre — a ciklus nem indít új ordert.`,
    };
  }

  // 3) A tényleges ciklus
  try {
    const result = await runTick({
      tickId,
      paperMode: process.env.TRADING_MODE !== "live",
      allowNewBuys: options.allowNewBuys,
      fence: { leaseKey: key, owner, fencingToken: lease.fencingToken },
    });

    // 4) Döntés mentése. A mentés sikere KÜLÖN követett: sikertelen mentés nem
    //    eredményezhet siker-heartbeatet (a régi kód itt csendben továbbment).
    let decisionId: string | undefined;
    let persisted = true;
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
            ref: {
              prices: result.prices,
              intent: result.rawAction,
              intentSymbol: result.decision.symbol || null,
              intentAmountPct: result.rawAmountPct,
            },
          })
          .returning();
        decisionId = inserted?.id;

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

        await evaluatePending(result.prices);
        await insertTickRun(tickId, result.process);
      } catch (e) {
        console.error("[scheduled-tick] mentés hiba:", e);
        persisted = false;
      }
    }

    // T23: sikeres heartbeat CSAK sikeres könyvelés mellett. Azonos hiba nem ismétlődik
    // minden tickben — a heartbeat modul deduplikál.
    await pingHeartbeat(persisted, { errorCode: persisted ? null : "persist_failed" });
    return {
      ok: persisted,
      tickId,
      decisionId,
      action: result.decision.action,
      overridden: result.decision.overridden,
      hasTrade: !!result.trade,
      persisted,
      lease: { key, owner, fencingToken: lease.fencingToken },
      error: persisted ? undefined : "A döntés mentése nem sikerült — a ciklus eredménye nem tartós.",
    };
  } catch (e) {
    console.error("[scheduled-tick] ciklus hiba:", e);
    // Hibánál elengedjük a lease-t, hogy egy újrapróbálás még dolgozhasson ebben a sávban.
    await releaseLease(key, owner);
    await pingHeartbeat(false, { errorCode: "cycle_error" });
    return { ok: false, tickId, error: String(e), lease: { key, owner, fencingToken: lease.fencingToken } };
  }
}

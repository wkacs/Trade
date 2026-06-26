import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { runTick } from "@/lib/engine/tick";
import { getDb, schema } from "@/db/client";

// A tick több külső hívást tesz (collectors párhuzamosan + 1-2 LLM hívás + DB),
// ezért megemeljük a függvény-időkorlátot (Vercelen a default 10s kevés lehet).
export const maxDuration = 60;
// Node runtime kell (neon, openai SDK, crypto) — nem Edge.
export const runtime = "nodejs";

/**
 * Vercel Cron célja — óránként hívódik. Lásd spec §4.
 *
 * BIZTONSÁG: a CRON_SECRET ellenőrzése (Vercel cron Authorization header-ben küldi).
 * Ha nincs CRON_SECRET beállítva, lokálisan nem védjük (fejlesztési kényelem).
 *
 * IDEMPOTENCIA: a tick_id (YYYY-MM-DD-HH) alapján deduplikál,
 * hogy egy kétszer futó cron ne okozzon dupla tranzakciót. Lásd spec §6.
 */
export async function POST(req: Request) {
  // 1) Auth ellenőrzés
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // 2) Tick id (UTC óra alapú)
  const now = new Date();
  const tickId = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}`;

  // 3) Idempotencia: volt már döntés ezzel a tick_id-del?
  // Low-level select-et használunk a relációs query API helyett, mert
  // a sémában nincsenek relations() definiálva — a findFirst csendben
  // undefined-ot adott, és a dedup sosem talált semmit.
  const db = getDb();
  if (db) {
    try {
      const existing = await db
        .select({ id: schema.decisions.id })
        .from(schema.decisions)
        .where(eq(schema.decisions.tickId, tickId))
        .limit(1);
      if (existing.length > 0) {
        return NextResponse.json({
          ok: true,
          skipped: true,
          tickId,
          reason: "already_processed",
        });
      }
    } catch (e) {
      // Ha a deduplikációs query hibázik (pl. még nincs migrálva a tábla),
      // nem akadályozzuk meg a ciklust — csak logolunk.
      console.error("[cron/tick] dedup check hiba:", e);
    }
  }

  // 4) A tényleges ciklus
  try {
    const result = await runTick({
      tickId,
      paperMode: process.env.TRADING_MODE !== "live",
    });

    // 5) Döntés mentése
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
          })
          .returning();
        decisionId = inserted?.id;

        // Risk override naplózása — ha a Risk Manager módosította/elutasította a
        // döntést. Lásd spec §3.4: „így látható, mikor akart az AI többet". Az eredeti
        // (Risk Manager előtti) action/amountPct a tick eredményéből jön.
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

        // MEGJEGYZÉS: a tranzakciót NEM itt mentjük. A motor (engine/tick.ts →
        // applyTrade) perzisztálja a trade-et a pozícióhoz kötve, a cash és a pozíció
        // frissítésével együtt (ha van inicializált portfólió). A korábbi különálló
        // trades-insert dupla sort okozott — eltávolítva.
      } catch (e) {
        // DB hiba nem akasztja meg a választ — a döntés már megvan
        console.error("[cron/tick] mentés hiba:", e);
      }
    }

    return NextResponse.json({
      ok: true,
      tickId,
      decisionId,
      action: result.decision.action,
      overridden: result.decision.overridden,
      hasTrade: !!result.trade,
    });
  } catch (e) {
    console.error("[cron/tick] ciklus hiba:", e);
    return NextResponse.json({ ok: false, tickId, error: String(e) }, { status: 500 });
  }
}

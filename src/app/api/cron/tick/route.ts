import { NextResponse } from "next/server";
import { runTick } from "@/lib/engine/tick";
import { getDb, schema } from "@/db/client";

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
  const db = getDb();
  if (db) {
    try {
      const existing = await db.query.decisions.findFirst({
        where: { tickId },
      } as any);
      if (existing) {
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

        // Tranzakció mentése, ha volt
        if (result.trade) {
          await db.insert(schema.trades).values({
            symbol: result.trade.symbol,
            side: result.trade.side,
            amountUsd: result.trade.amountUsd,
            price: result.trade.price,
            qty: result.trade.qty,
            feeUsd: result.trade.feeUsd,
            mode: result.trade.mode,
          });
        }
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

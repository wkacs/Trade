import { NextResponse } from "next/server";
import { getDb, schema } from "@/db/client";
import { asc } from "drizzle-orm";
import { buildFeatures } from "@/lib/ml/features";
import { predict } from "@/lib/ml/predictor";
import type { DataPoint } from "@/lib/types";

// Élő, DB-író route (backtests insert) — soha ne fusson le build-időben.
// force-dynamic nélkül a Next.js a build során végrehajtaná és cache-elné.
export const dynamic = "force-dynamic";

/**
 * Egyszerű backtest: a raw_events táblán végigfut, ML jeleket generál,
 * és szimulált P&L-t számol. Lásd spec §3.5.
 *
 * Ez a vázlat — amíg nincs elegendő történelmi adat, naiv becslést ad.
 * A valós stratégia a demo-fázis után finomítandó.
 */
export async function GET() {
  const db = getDb();
  if (!db) {
    return NextResponse.json({
      pnlPct: 0,
      tradesCount: 0,
      note: "DATABASE_URL hiányzik — backtest nem futtatható.",
    });
  }

  try {
    const rows = await db.query.rawEvents.findMany({
      orderBy: asc(schema.rawEvents.ts),
    });
    // A DB sorokat DataPoint-tá alakítjuk a feature builder számára
    const events: DataPoint[] = rows.map((r) => ({
      source: r.source as DataPoint["source"],
      symbol: r.symbol,
      timestamp: new Date(r.ts).getTime(),
      kind: r.kind as DataPoint["kind"],
      ...((r.payload as object) ?? {}),
    }));

    const features = buildFeatures(events);
    const signals = await predict(features);

    // Naív backtest: "up" jel → vettünk volna; számoljuk a szimulált P&L-t.
    let pnlPct = 0;
    let tradesCount = signals.length;
    for (const s of signals) {
      if (s.direction1h === "up") pnlPct += s.confidence * 0.01;
      else if (s.direction1h === "down") pnlPct -= s.confidence * 0.01;
    }

    let backtestId: string | undefined;
    try {
      const [saved] = await db
        .insert(schema.backtests)
        .values({
          strategy: "naive-ml-signal",
          startTs: rows[0]?.ts ?? new Date(),
          endTs: rows[rows.length - 1]?.ts ?? new Date(),
          resultPnlPct: pnlPct,
          tradesCount,
        })
        .returning();
      backtestId = saved?.id;
    } catch (e) {
      console.error("[api/backtest] mentés hiba:", e);
    }

    return NextResponse.json({ pnlPct, tradesCount, backtestId });
  } catch (e) {
    console.error("[api/backtest]", e);
    return NextResponse.json({ pnlPct: 0, tradesCount: 0, error: "DB hiba" }, { status: 500 });
  }
}

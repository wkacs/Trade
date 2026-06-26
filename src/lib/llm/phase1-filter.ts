import type { DataPoint } from "@/lib/types";
import { chatJson } from "./client";
import { Phase1ResultSchema, type Phase1Result } from "./schemas";

const SYSTEM = `Te egy kripto-trading asszisztens első szűrő fázisa vagy.
A feladat: eldönteni, hogy az elmúlt órában történt-e olyan érdemi esemény
(hír, whale-mozgás, jelentős árváltozás), ami indokolná egy BUY/SELL döntést.

Válaszolj KIZÁRÓLAG ezzel a JSON-objektummal, pontosan ezekkel a mezőnevekkel,
semmilyen extra szöveg vagy mező nélkül:
{
  "shouldDecide": true_vagy_false,
  "summary": "rövid magyar összefoglaló az óráról",
  "notableEvents": [ { "symbol": "BTC", "reason": "miért fontos" } ]
}
Ha nincs semmi érdemi: {"shouldDecide": false, "summary": "...", "notableEvents": []}.`;

/**
 * Phase-1: GLM-4-Flash (ingyenes) minden órában. Ez a ciklus 90%-a.
 * Lásd spec §3.2.
 */
export async function shouldDecide(events: DataPoint[]): Promise<Phase1Result> {
  if (events.length === 0) {
    return { shouldDecide: false, summary: "Nincsenek események.", notableEvents: [] };
  }
  const compact = events.map((e) => ({
    s: e.symbol,
    k: e.kind,
    ...(e.price ? { px: e.price.usd, ch: e.price.change24hPct } : {}),
    ...(e.news ? { t: e.news.title, sent: e.news.sentiment } : {}),
    ...(e.whale ? { amt: e.whale.amountUsd, dir: e.whale.direction } : {}),
    ...(e.rss ? { t: e.rss.title, src: e.rss.source } : {}),
  }));
  const fallback: Phase1Result = {
    shouldDecide: false,
    summary: "LLM hiba, HOLD.",
    notableEvents: [],
  };
  const { data, raw } = await chatJson<Phase1Result>(
    process.env.LLM_MODEL_PHASE1 ?? "glm-4-flash",
    SYSTEM,
    JSON.stringify(compact),
    fallback,
  );
  // Robusztus: ha a modell rossz alakú JSON-t ad, HOLD-ra esünk vissza,
  // nem dobunk (spec §6: sérült JSON → HOLD, sosem omlik össze a ciklus).
  const parsed = Phase1ResultSchema.safeParse(data);
  if (!parsed.success) {
    console.warn("[phase1] séma-eltérés → HOLD. Nyers kimenet:", raw.slice(0, 200));
    return fallback;
  }
  return parsed.data;
}

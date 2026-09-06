import type { DataPoint } from "@/lib/types";
import { chatJson, type LlmUsage } from "./client";
import { Phase1ResultSchema, type Phase1Result } from "./schemas";

const SYSTEM = `Te egy kripto-trading asszisztens első szűrő fázisa vagy.
A feladat: eldönteni, hogy az elmúlt órában történt-e olyan érdemi esemény
(hír, whale-mozgás, jelentős árváltozás), ami indokolná egy BUY/SELL döntést.

FONTOS: az extrém alacsony piaci hangulat (Fear & Greed index < 25) — különösen
jelentős áreséssel együtt — CSELEKVÉSRE ÉRDEMES esemény (potenciális halmozási/BUY
lehetőség), NEM automatikus HOLD. Az extrém félelmet ne értékeld „nyugodt órának".

Válaszolj KIZÁRÓLAG ezzel a JSON-objektummal, pontosan ezekkel a mezőnevekkel,
semmilyen extra szöveg vagy mező nélkül:
{
  "shouldDecide": true_vagy_false,
  "summary": "rövid magyar összefoglaló az óráról",
  "notableEvents": [ { "symbol": "BTC", "reason": "miért fontos" } ]
}
Ha nincs semmi érdemi: {"shouldDecide": false, "summary": "...", "notableEvents": []}.`;

/** A phase-1 eredménye a hívás mérhető adataival együtt. */
export interface Phase1Outcome extends Phase1Result {
  /** Az LLM-hívás mérhető adatai. `null`, ha nem is volt hívás. */
  usage: LlmUsage | null;
}

/**
 * Phase-1: GLM-4-Flash (ingyenes) minden órában. Ez a ciklus 90%-a.
 * Lásd spec §3.2.
 *
 * A `usage` KÖTELEZŐEN kijön: enélkül egy bukott phase-1 a naplóban ugyanúgy nézne ki,
 * mint egy nyugodt óra — 2026-09-06-án órákig ez rejtette el a 30 s-os időtúllépéseket.
 */
export async function shouldDecide(events: DataPoint[]): Promise<Phase1Outcome> {
  if (events.length === 0) {
    return { shouldDecide: false, summary: "Nincsenek események.", notableEvents: [], usage: null };
  }
  const compact = events.map((e) => ({
    s: e.symbol,
    k: e.kind,
    ...(e.price ? { px: e.price.usd, ch: e.price.change24hPct } : {}),
    ...(e.news ? { t: e.news.title, sent: e.news.sentiment } : {}),
    ...(e.whale ? { amt: e.whale.amountUsd, dir: e.whale.direction } : {}),
    ...(e.rss ? { t: e.rss.title, src: e.rss.source } : {}),
    ...(e.sentiment ? { fng: e.sentiment.value, lbl: e.sentiment.classification } : {}),
    ...(e.social ? { t: e.social.title, score: e.social.score, sub: e.social.subreddit } : {}),
    // Pozicionáltság — ortogonális az árra: nem azt mondja, mennyi az ár, hanem hogy a
    // tömeg hogyan áll benne. A rövid kulcsnevek a token-költséget fogják vissza.
    ...(e.derivatives
      ? {
          fund: e.derivatives.fundingRatePct,
          oiChg: e.derivatives.openInterestChange1hPct,
          taker: e.derivatives.takerBuySellRatio,
          ls: e.derivatives.longShortAccountRatio,
        }
      : {}),
    ...(e.premium ? { prem: e.premium.premiumPct } : {}),
  }));
  const fallback: Phase1Result = {
    shouldDecide: false,
    summary: "LLM hiba, HOLD.",
    notableEvents: [],
  };
  const { data, raw, usage } = await chatJson<Phase1Result>(
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
    return { ...fallback, usage: usage ?? null };
  }
  return { ...parsed.data, usage: usage ?? null };
}

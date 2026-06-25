import { collectAll, type DataCollector } from "@/lib/collectors/base";
import { CoinGeckoCollector } from "@/lib/collectors/coingecko";
import { CryptoPanicCollector } from "@/lib/collectors/cryptopanic";
import { WhaleAlertCollector } from "@/lib/collectors/whalealert";
import { buildFeatures } from "@/lib/ml/features";
import { predict } from "@/lib/ml/predictor";
import { shouldDecide } from "@/lib/llm/phase1-filter";
import { decide } from "@/lib/llm/phase2-decide";
import { applyRisk } from "@/lib/risk/risk-manager";
import { PaperBroker } from "@/lib/execution/paper-broker";
import { COIN_UNIVERSE } from "@/lib/config";
import type { Decision, Trade, DataPoint, RawDecision } from "@/lib/types";

export interface TickInput {
  tickId: string; // YYYY-MM-DD-HH
  paperMode: boolean;
}

export interface TickResult {
  events: DataPoint[];
  decision: Decision;
  trade: Trade | null;
}

/** A kezdőtőke (demo paper módhoz). A valós futásnál a DB-ből töltődik (accounting.ts). */
const PAPER_CAPITAL_USD = 10000;

/**
 * A teljes óránkénti ciklus vezérlője. Lásd spec §4.
 *
 * Lépések:
 *  1) Data Collectors → events
 *  2) ML feature + predict → mlSignals
 *  3) Phase-1 (GLM-4-Flash): érdemes-e dönteni?
 *  4) Ha igen → Phase-2 (GLM-5.2): strukturált döntés + érvelés
 *  5) Risk Manager validál/módosít
 *  6) Execution (paper vagy binance)
 */
export async function runTick(input: TickInput): Promise<TickResult> {
  // 1) Collectors — csak azok, amikhez van kulcs / nem kell kulcs
  const collectors: DataCollector[] = [new CoinGeckoCollector([...COIN_UNIVERSE])];
  if (process.env.CRYPTOPANIC_TOKEN)
    collectors.push(new CryptoPanicCollector(process.env.CRYPTOPANIC_TOKEN, [...COIN_UNIVERSE]));
  if (process.env.WHALEALERT_KEY)
    collectors.push(new WhaleAlertCollector(process.env.WHALEALERT_KEY, [...COIN_UNIVERSE]));

  const events = await collectAll(collectors);

  // 2) ML signals
  const features = buildFeatures(events);
  const mlSignals = await predict(features);

  // 3) Phase-1: érdemes-e dönteni? (GLM-4-Flash, ingyenes, minden órában)
  const phase1 = await shouldDecide(events);

  // Alapértelmezett döntés: HOLD a phase-1 összegzésével.
  // Ha phase-1 nemet mond, NEM hívjuk a phase-2-t — ez a ciklus 90%-a.
  let rawDecision: RawDecision = {
    action: "HOLD",
    symbol: "",
    amountPct: 0,
    confidence: 0.3,
    reasoning: phase1.summary,
    model: "phase1/glm-4-flash",
  };

  if (phase1.shouldDecide) {
    // 4) Phase-2: GLM-5.2 strukturált döntés érveléssel
    const phase2 = await decide({
      events,
      mlSignals,
      portfolio: { cashUsd: PAPER_CAPITAL_USD, positions: [] },
    });
    rawDecision = {
      action: phase2.action,
      symbol: phase2.symbol ?? "",
      amountPct: phase2.amountPct,
      confidence: phase2.confidence,
      reasoning: phase2.reasoning,
      model: process.env.LLM_MODEL_PHASE2 ?? "glm-5.2",
    };
  }

  // 5) Risk Manager — a limitek érvényesítése az AI döntése felett
  const decision = applyRisk(rawDecision, {
    cashUsd: PAPER_CAPITAL_USD,
    positions: [],
    totalEquity: () => PAPER_CAPITAL_USD,
    dayPnlPct: 0,
  });

  // 6) Execution — csak paper módban; live broker a 2. fázisban
  let trade: Trade | null = null;
  if (input.paperMode && decision.action !== "HOLD" && decision.symbol) {
    const priceEvent = events.find(
      (e) => e.symbol === decision.symbol && e.kind === "price",
    );
    const price = priceEvent?.price?.usd;
    if (price) {
      const broker = new PaperBroker({
        cashUsd: PAPER_CAPITAL_USD,
        positions: [],
      });
      trade = await broker.execute(
        {
          side: decision.action,
          symbol: decision.symbol,
          amountUsd: PAPER_CAPITAL_USD * decision.amountPct,
          stopLossPct: 0.05,
        },
        price,
      );
    }
  }

  return { events, decision, trade };
}

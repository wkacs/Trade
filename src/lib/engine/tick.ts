import { collectAll, type DataCollector } from "@/lib/collectors/base";
import { CoinGeckoCollector } from "@/lib/collectors/coingecko";
import { CryptoPanicCollector } from "@/lib/collectors/cryptopanic";
import { WhaleAlertCollector } from "@/lib/collectors/whalealert";
import { RSSCollector } from "@/lib/collectors/rss";
import { BinanceOHLCCollector } from "@/lib/collectors/binance";
import { FearGreedCollector } from "@/lib/collectors/feargreed";
import { RedditCollector } from "@/lib/collectors/reddit";
import { buildFeatures } from "@/lib/ml/features";
import { predict } from "@/lib/ml/predictor";
import { shouldDecide } from "@/lib/llm/phase1-filter";
import { decide } from "@/lib/llm/phase2-decide";
import { applyRisk } from "@/lib/risk/risk-manager";
import { PaperBroker } from "@/lib/execution/paper-broker";
import { BinanceBroker } from "@/lib/execution/binance-broker";
import type { Broker } from "@/lib/execution/broker";
import { COIN_UNIVERSE, RISK_LIMITS, RSS_SOURCES, REDDIT_SOURCES } from "@/lib/config";
import { loadPortfolioState, applyTrade } from "@/lib/portfolio/accounting";
import type { Decision, Trade, DataPoint, RawDecision } from "@/lib/types";

export interface TickInput {
  tickId: string; // YYYY-MM-DD-HH
  paperMode: boolean;
}

export interface TickResult {
  events: DataPoint[];
  decision: Decision;
  trade: Trade | null;
  /** Ha a trade DB-be lett perzisztálva, a pozíció id-ja; null ha nem volt DB. */
  positionId?: string | null;
  /** A Risk Manager ELŐTTI eredeti döntés (risk_overrides naplózáshoz, ha overridden). */
  rawAction: RawDecision["action"];
  rawAmountPct: number;
}

/** Fallback demo tőke, ha nincs DB vagy nincs inicializált portfólió (pl. tesztek). */
const PAPER_CAPITAL_FALLBACK_USD = 10000;

/**
 * A teljes óránkénti ciklus vezérlője. Lásd spec §4.
 *
 * Lépések:
 *  1) Portfólió-állapot betöltése DB-ből (ha van); nélküle demo fallback
 *  2) Data Collectors → events
 *  3) ML feature + predict → mlSignals
 *  4) Phase-1 (GLM-4-Flash): érdemes-e dönteni?
 *  5) Ha igen → Phase-2 (GLM-5.2): strukturált döntés + érvelés
 *  6) Risk Manager validál/módosít
 *  7) Execution (paper vagy binance)
 *  8) Ha volt trade és van DB: perzisztencia (cash/positions/trades)
 */
export async function runTick(input: TickInput): Promise<TickResult> {
  // 1) Portfólió-állapot betöltése. Ha nincs DB / nincs portfólió, demo fallback —
  // így a unit tesztek DB nélkül is determinisztikusan futnak.
  const dbState = await loadPortfolioState();
  const cashUsd = dbState?.cashUsd ?? PAPER_CAPITAL_FALLBACK_USD;
  const positions = dbState?.positions ?? [];
  const dayPnlPct = dbState?.dayPnlPct ?? 0;

  // 2) Collectors — kulcs nélküliek mindig: CoinGecko (aktuális ár), Binance (OHLC
  // gyertyák az ML-hez), RSS (hír-kontextus), Fear & Greed (piaci hangulat).
  // A kulcsosak (CryptoPanic/WhaleAlert) csak ha van token.
  const collectors: DataCollector[] = [
    new CoinGeckoCollector([...COIN_UNIVERSE]),
    new BinanceOHLCCollector([...COIN_UNIVERSE]),
    new RSSCollector(RSS_SOURCES),
    new FearGreedCollector(),
  ];
  if (process.env.CRYPTOPANIC_TOKEN)
    collectors.push(new CryptoPanicCollector(process.env.CRYPTOPANIC_TOKEN, [...COIN_UNIVERSE]));
  if (process.env.WHALEALERT_KEY)
    collectors.push(new WhaleAlertCollector(process.env.WHALEALERT_KEY, [...COIN_UNIVERSE]));
  // Reddit OAuth-ot igényel (a kulcs nélküli JSON-t a Reddit 403-mal tiltja) — kulcs-gate.
  if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET)
    collectors.push(
      new RedditCollector(process.env.REDDIT_CLIENT_ID, process.env.REDDIT_CLIENT_SECRET, REDDIT_SOURCES),
    );

  const events = await collectAll(collectors);

  // Az LLM-nek tisztított nézet: a Binance nyers gyertyák (24×3 ár-pont) az ML-t
  // etetik, de a prompt-ot nem terheljük velük. Az LLM az aktuális árat (CoinGecko),
  // a hírt (RSS) és a hangulatot (Fear & Greed) látja + az ML-jeleket.
  const llmEvents = events.filter((e) => e.source !== "binance");

  // 3) ML signals — a TELJES events-ből (a Binance idősorral) számol valódi feature-t
  const features = buildFeatures(events);
  const mlSignals = await predict(features);

  // 4) Phase-1: érdemes-e dönteni? (GLM-4-Flash, ingyenes, minden órában)
  const phase1 = await shouldDecide(llmEvents);

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
    // 5) Phase-2: GLM-5.2 strukturált döntés érveléssel (tisztított LLM-nézet)
    const phase2 = await decide({
      events: llmEvents,
      mlSignals,
      portfolio: { cashUsd, positions: positions.map((p) => ({ symbol: p.symbol, qty: p.qty, entryPrice: 0 })) },
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

  // 6) Risk Manager — a limitek érvényesítése az AI döntése felett (betöltött állapottal)
  const decision = applyRisk(rawDecision, {
    cashUsd,
    positions,
    totalEquity: () => dbState?.totalEquity() ?? cashUsd,
    dayPnlPct,
  });

  // 7) Execution — a broker a mód szerint cserélődik (spec §3.3):
  //    paper → PaperBroker (szimuláció), live → BinanceBroker (valódi Binance order).
  //    A Risk Manager limitjei már a broker ELŐTT érvényesültek.
  let trade: Trade | null = null;
  let positionId: string | null = null;
  if (decision.action !== "HOLD" && decision.symbol) {
    const priceEvent = events.find(
      (e) => e.symbol === decision.symbol && e.kind === "price",
    );
    const price = priceEvent?.price?.usd;
    if (price) {
      const order = {
        side: decision.action,
        symbol: decision.symbol,
        amountUsd: cashUsd * decision.amountPct,
        stopLossPct: RISK_LIMITS.stopLossPct,
      };
      const broker: Broker = input.paperMode
        ? new PaperBroker({
            cashUsd,
            positions: positions.map((p) => ({ symbol: p.symbol, qty: p.qty, valueUsd: p.valueUsd })),
          })
        : new BinanceBroker(process.env.BINANCE_API_KEY ?? "", process.env.BINANCE_API_SECRET ?? "");
      trade = await broker.execute(order, price);

      // 8) Perzisztencia — a DB-egyenleget mindkét módban frissítjük (live módban ez a
      // valós Binance-számla TÜKRE; a stopPrice = entry * (1 - stopLoss%)).
      if (dbState && trade) {
        const stopPrice =
          trade.side === "BUY" ? trade.price * (1 - RISK_LIMITS.stopLossPct) : trade.price;
        const persisted = await applyTrade(trade, stopPrice);
        positionId = persisted?.positionId ?? null;
      }
    }
  }

  return {
    events,
    decision,
    trade,
    positionId,
    // A Risk Manager ELŐTTI eredeti döntés — a cron route ebből naplózza a
    // risk_overrides sort, ha a Risk Manager módosított/elutasított. Lásd spec §3.4.
    rawAction: rawDecision.action,
    rawAmountPct: rawDecision.amountPct,
  };
}

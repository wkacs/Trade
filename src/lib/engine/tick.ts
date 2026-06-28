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
import { loadPortfolioState, applyTrade, setStopPrice } from "@/lib/portfolio/accounting";
import { buildTickProcess } from "@/lib/engine/tick-process";
import { getPerformanceSummary } from "@/lib/portfolio/evaluate";
import { remainingWeeklyBudget } from "@/lib/strategy/weekly-budget";
import { planProfitCycle } from "@/lib/engine/profit-cycle";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import { computeAtr } from "@/lib/strategy/atr";
import { passesTrendFilter } from "@/lib/strategy/entry-filter";
import type { Decision, Trade, DataPoint, RawDecision } from "@/lib/types";

export interface TickInput {
  tickId: string; // YYYY-MM-DD-HH
  paperMode: boolean;
}

/** Egy kód-alapú profit-ciklus akció (stop-loss / take-profit / DCA). */
export interface CycleAction {
  kind: "stop-loss" | "take-profit" | "dca";
  side: "BUY" | "SELL";
  symbol: string;
  /** SELL-nél a végrehajtás után töltődik (terv-állapotban hiányozhat). */
  amountUsd?: number;
  /** BUY-nál a végrehajtás után töltődik (terv-állapotban hiányozhat). */
  qty?: number;
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
  /** Aktuális árak symbolonként (a döntés ref-jéhez + utólagos kiértékeléshez). */
  prices: Record<string, number>;
  /**
   * A kód-alapú profit-ciklus által végrehajtott akciók (az AI-lánc ELŐTT futnak).
   * Üres tömb, ha nem volt DB/pozíció vagy nem volt teendő. Lásd profit-cycle spec §2.
   */
  cycleActions: CycleAction[];
  /** A tick teljes folyamat-pillanatképe (átláthatóság, tick_runs napló). */
  process: import("@/lib/engine/tick-process").TickProcess;
}

/** Fallback demo tőke, ha nincs DB vagy nincs inicializált portfólió (pl. tesztek). */
const PAPER_CAPITAL_FALLBACK_USD = 10000;

/** Szimulált díj — egyezik a PaperBroker-rel (0.1%). */
const PAPER_FEE_PCT = 0.001;

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
  // Munka-állapot: a profit-ciklus akciói (stop/profit/DCA) menet közben frissítik,
  // hogy az AI-lánc (és a Risk Manager) már a valós, aktualizált egyenleget lássa.
  let cashUsd = dbState?.cashUsd ?? PAPER_CAPITAL_FALLBACK_USD;
  let workingPositions = (dbState?.positions ?? []).map((p) => ({ ...p }));
  // A napi P&L betöltéskor a realized SELL-ekből áll; az MTM blokk (lent) felülírja
  // az aktuális-ár-alapú equity/initialCapital aránnyal, ha van DB. Lásd spec §A.
  let dayPnlPct = dbState?.dayPnlPct ?? 0;
  const totalEquityNow = () =>
    cashUsd + workingPositions.reduce((s, p) => s + p.valueUsd, 0);

  /** Egy végrehajtott trade tükrözése a munka-állapotban (cash + pozíciók). */
  const recordTrade = (trade: Trade) => {
    if (trade.side === "BUY") {
      cashUsd -= trade.amountUsd;
      const ex = workingPositions.find((p) => p.symbol === trade.symbol);
      if (ex) {
        const newQty = ex.qty + trade.qty;
        ex.entryPrice = (ex.qty * ex.entryPrice + trade.qty * trade.price) / newQty;
        ex.qty = newQty;
        ex.valueUsd += trade.amountUsd;
        ex.stopPrice = trade.price * (1 - RISK_LIMITS.stopLossPct);
      } else {
        workingPositions.push({
          id: "",
          symbol: trade.symbol,
          qty: trade.qty,
          entryPrice: trade.price,
          stopPrice: trade.price * (1 - RISK_LIMITS.stopLossPct),
          valueUsd: trade.amountUsd,
        });
      }
    } else {
      cashUsd += trade.amountUsd;
      const ex = workingPositions.find((p) => p.symbol === trade.symbol);
      if (ex) {
        ex.qty -= trade.qty;
        ex.valueUsd = Math.max(0, ex.valueUsd - trade.qty * ex.entryPrice);
        if (ex.qty <= 1e-7) workingPositions = workingPositions.filter((p) => p !== ex);
      }
    }
  };

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

  // Aktuális ár symbolonként (a legfrissebb price-pont) — a döntés ref-jéhez + kiértékeléshez.
  const prices: Record<string, number> = {};
  const latestTs: Record<string, number> = {};
  for (const e of events) {
    if (e.kind === "price" && e.price && (latestTs[e.symbol] === undefined || e.timestamp > latestTs[e.symbol])) {
      latestTs[e.symbol] = e.timestamp;
      prices[e.symbol] = e.price.usd;
    }
  }

  // ── MARK-TO-MARKET (MTM): a workingPositions értékét az AKTUÁLIS árral számoljuk,
  //    nem a belépésivel. Így a totalEquityNow() és a napi P&L valódi, és a napi -3%
  //    circuit breaker (RISK_LIMITS.dailyLossCircuitBreakerPct) nem vak a nem-realizált
  //    veszteségre. Lásd profit-cycle spec kiegészítés (MTM, §A).
  //    Csak DB-állapot (dbState) esetén — DB nélkül (unit tesztek) a régi viselkedés él.
  if (dbState) {
    for (const p of workingPositions) {
      const px = prices[p.symbol];
      if (px !== undefined) {
        p.valueUsd = px * p.qty;
      }
    }
    // Napi P&L MTM-alapú: totalEquityNow/initialCapital - 1.
    // A dbState.initialCapitalUsd a portfolios sorból jön (loadPortfolioState).
    const initialCapitalUsd = dbState.initialCapitalUsd;
    const mtmDayPnlPct =
      initialCapitalUsd > 0 ? totalEquityNow() / initialCapitalUsd - 1 : 0;
    dayPnlPct = mtmDayPnlPct;
  }

  // ── KÓD-ALAPÚ PROFIT-CIKLUS (az AI-lánc ELŐTT). Lásd profit-cycle spec §2–§4.
  //    Sorrend: stop-loss → take-profit → fear-greedy DCA. Determinisztikus, nem
  //    függ AI-intuíciótól. Csak ha van DB (perzisztencia + valós pozíciók); DB nélkül
  //    (unit tesztek) a ciklus kimarad, és a régi viselkedés érvényes.
  const cycleActions: CycleAction[] = [];
  let weeklyRemaining: number | undefined;

  /** Egy profit-ciklus order végrehajtása + perzisztálása + munka-állapot frissítése. */
  const executeCycleOrder = async (
    side: "BUY" | "SELL",
    symbol: string,
    opts: { qty?: number; amountUsd?: number },
    price: number,
    origin: "dca" | "stop-loss" | "take-profit",
  ): Promise<Trade | null> => {
    let trade: Trade | null = null;
    if (input.paperMode) {
      // Paper: közvetlen trade-építés. A SELL PONTOS qty-vel megy (a stop a teljes, a
      // take-profit a fél pozíciót zárja), a BUY USD-összeg + cash-clamp alapú.
      let gross: number;
      let qty: number;
      if (side === "SELL") {
        qty = opts.qty ?? 0;
        gross = qty * price;
      } else {
        gross = Math.min(opts.amountUsd ?? 0, Math.max(0, cashUsd));
        qty = (gross - gross * PAPER_FEE_PCT) / price;
      }
      if (gross <= 0 || qty <= 0) return null;
      trade = {
        id: crypto.randomUUID(),
        orderId: crypto.randomUUID(),
        symbol,
        side,
        amountUsd: gross,
        price,
        qty,
        feeUsd: gross * PAPER_FEE_PCT,
        executedAt: Date.now(),
        mode: "paper",
      };
    } else {
      // Live: valódi Binance order (mint az AI-úton). A SELL amountUsd ≈ qty * ár.
      const amountUsd = side === "SELL" ? (opts.qty ?? 0) * price : opts.amountUsd ?? 0;
      if (amountUsd <= 0) return null;
      const broker = new BinanceBroker(
        process.env.BINANCE_API_KEY ?? "",
        process.env.BINANCE_API_SECRET ?? "",
      );
      trade = await broker.execute(
        { side, symbol, amountUsd, stopLossPct: RISK_LIMITS.stopLossPct },
        price,
      );
    }
    if (!trade) return null;
    trade.origin = origin;
    // Perzisztencia (mindkét módban): a DB az egyenleg tükre. stopPrice = entry*(1−stop%).
    if (dbState) {
      const stopPrice =
        trade.side === "BUY" ? trade.price * (1 - RISK_LIMITS.stopLossPct) : trade.price;
      await applyTrade(trade, stopPrice);
    }
    recordTrade(trade);
    return trade;
  };

  if (dbState) {
    // KÓD-ALAPÚ PROFIT-CIKLUS a közös, tiszta planProfitCycle()-lel — a backtest UGYANEZT
    // hívja, így nincs drift. A planner DÖNT (ratchet→stop/TP→DCA); a végrehajtás itt marad.
    weeklyRemaining = await remainingWeeklyBudget(totalEquityNow());

    const fgEvent = events.find((e) => e.kind === "sentiment" && e.sentiment);
    const fearGreedValue = fgEvent?.sentiment?.value ?? null;
    // A 24h változás a CoinGecko ár-pontból jön (a kosár coinjaira, symbolonként egyszer).
    const coinChanges = events
      .filter(
        (e) =>
          e.source === "coingecko" &&
          e.kind === "price" &&
          e.price !== undefined &&
          (COIN_UNIVERSE as readonly string[]).includes(e.symbol),
      )
      .map((e) => ({ symbol: e.symbol, change24hPct: e.price!.change24hPct }));

    // Live candle-band: low=high=close=aktuális ár (csak a spot ismert).
    const candles: Record<string, { low: number; high: number; close: number }> = {};
    for (const p of workingPositions) {
      const px = prices[p.symbol];
      if (px !== undefined) candles[p.symbol] = { low: px, high: px, close: px };
    }

    // Per-symbol ATR + trend-flag a Binance OHLC events-ből (a buildFeatures is ezt eszi).
    // A DataPoint csak price.usd-t hordoz → close-only buffer (high=low=close). A default
    // stopMode:"fixed"+entryFilter:"off" miatt ez NEM befolyásolja a live viselkedést (parity).
    const ohlcBySymbol: Record<string, { high: number; low: number; close: number }[]> = {};
    for (const e of events) {
      if (e.source === "binance" && e.kind === "price" && e.price) {
        (ohlcBySymbol[e.symbol] ??= []).push({ high: e.price.usd, low: e.price.usd, close: e.price.usd });
      }
    }
    const atrBySymbol: Record<string, number> = {};
    const trendOkBySymbol: Record<string, boolean> = {};
    for (const sym of COIN_UNIVERSE) {
      const buf = ohlcBySymbol[sym] ?? [];
      atrBySymbol[sym] = computeAtr(buf, DEFAULT_STRATEGY.atrPeriod);
      trendOkBySymbol[sym] = passesTrendFilter(
        buf.map((b) => b.close),
        DEFAULT_STRATEGY.entryFilterSmaPeriod,
      );
    }

    const plan = planProfitCycle(
      {
        positions: workingPositions.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          qty: p.qty,
          entryPrice: p.entryPrice,
          stopPrice: p.stopPrice,
        })),
        candles,
        fearGreedValue,
        coinChanges,
        weeklyBudgetRemainingUsd: weeklyRemaining,
        totalEquity: totalEquityNow(),
        atrBySymbol,
        trendOkBySymbol,
      },
      DEFAULT_STRATEGY,
    );

    // Trailing-stop ratchet perzisztálása + munka-állapot frissítése (túléli a tickeket).
    for (const u of plan.stopUpdates) {
      const pos = workingPositions.find((p) => p.id === u.positionId);
      if (pos) pos.stopPrice = u.newStop;
      await setStopPrice(u.positionId, u.newStop);
    }

    // Orderek végrehajtása: a SELL-ek ELŐBB (a felszabaduló cash a DCA-nak hasznosul).
    const sells = plan.orders.filter((o) => o.side === "SELL");
    const buys = plan.orders.filter((o) => o.side === "BUY");
    for (const o of [...sells, ...buys]) {
      const px = prices[o.symbol];
      if (px === undefined) continue;
      const trade =
        o.side === "SELL"
          ? await executeCycleOrder("SELL", o.symbol, { qty: o.qty }, o.triggerPrice ?? px, o.kind)
          : await executeCycleOrder("BUY", o.symbol, { amountUsd: o.amountUsd }, px, o.kind);
      if (trade) {
        cycleActions.push({
          kind: o.kind,
          side: o.side,
          symbol: o.symbol,
          amountUsd: trade.amountUsd,
          qty: trade.qty,
        });
        // A DCA után az AI BUY-ja a CSÖKKENTETT heti keretet lássa a Risk Manager kapujában.
        if (o.side === "BUY") weeklyRemaining -= trade.amountUsd;
      }
    }
  }

  // 3) ML signals — a TELJES events-ből (a Binance idősorral) számol valódi feature-t
  const features = buildFeatures(events);
  const mlSignals = await predict(features);

  // 4) Phase-1: érdemes-e dönteni? (GLM-4-Flash, ingyenes, minden órában)
  const phase1 = await shouldDecide(llmEvents);

  // Alapértelmezett döntés: HOLD a phase-1 összegzésével.
  // Ha phase-1 nemet mond, NEM hívjuk a phase-2-t — ez a ciklus 90%-a.
  let phase2Snapshot: import("@/lib/engine/tick-process").TickProcess["phase2"] = null;
  let rawDecision: RawDecision = {
    action: "HOLD",
    symbol: "",
    amountPct: 0,
    confidence: 0.3,
    reasoning: phase1.summary,
    model: "phase1/glm-4-flash",
  };

  if (phase1.shouldDecide) {
    // 5) Phase-2: GLM-5.2 strukturált döntés érveléssel (tisztított LLM-nézet).
    // A korábbi döntések „bejött volna?" összegzése visszacsatolásként megy be.
    const performance = await getPerformanceSummary();
    const phase2 = await decide({
      events: llmEvents,
      mlSignals,
      portfolio: { cashUsd, positions: workingPositions.map((p) => ({ symbol: p.symbol, qty: p.qty, entryPrice: 0 })) },
      performance: {
        actionable: performance.actionable,
        hitRate: performance.hitRate,
        avgHypotheticalPnlPct: performance.avgHypotheticalPnlPct,
      },
    });
    rawDecision = {
      action: phase2.action,
      symbol: phase2.symbol ?? "",
      amountPct: phase2.amountPct,
      confidence: phase2.confidence,
      reasoning: phase2.reasoning,
      model: process.env.LLM_MODEL_PHASE2 ?? "glm-5.2",
    };
    phase2Snapshot = {
      action: phase2.action,
      symbol: phase2.symbol ?? null,
      amountPct: phase2.amountPct,
      confidence: phase2.confidence,
      reasoning: phase2.reasoning,
    };
  }

  // 6) Risk Manager — a limitek érvényesítése az AI döntése felett (max pozíció %, max
  //    egyidejű pozíció, napi circuit breaker). A heti DCA-keret már NEM gátolja az AI
  //    BUY-t (csak a DCA-t a planner-ben) → nincs HOLD-fagyás. Lásd tournament spec §6.
  const decision = applyRisk(
    rawDecision,
    {
      cashUsd,
      positions: workingPositions,
      totalEquity: totalEquityNow,
      dayPnlPct,
    },
    {
      maxPositionPct: RISK_LIMITS.maxPositionPct,
      maxConcurrentPositions: RISK_LIMITS.maxConcurrentPositions,
      dailyLossCircuitBreakerPct: RISK_LIMITS.dailyLossCircuitBreakerPct,
    },
  );

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
            positions: workingPositions.map((p) => ({ symbol: p.symbol, qty: p.qty, valueUsd: p.valueUsd })),
          })
        : new BinanceBroker(process.env.BINANCE_API_KEY ?? "", process.env.BINANCE_API_SECRET ?? "");
      trade = await broker.execute(order, price);
      if (trade) trade.origin = "ai";

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

  const fgForProcess = events.find((e) => e.kind === "sentiment" && e.sentiment)?.sentiment ?? null;
  const tickProcess = buildTickProcess({
    tickId: input.tickId,
    prices,
    fearGreed: fgForProcess ? { value: fgForProcess.value, classification: fgForProcess.classification } : null,
    mlSignals: mlSignals.map((s) => ({ symbol: s.symbol, direction1h: s.direction1h, confidence: s.confidence })),
    cycleActions,
    phase1: { shouldDecide: phase1.shouldDecide, summary: phase1.summary },
    phase2: phase2Snapshot,
    decision: {
      action: decision.action,
      symbol: decision.symbol || null,
      overridden: decision.overridden,
      overrideReason: decision.overrideReason ?? null,
    },
    aiTrade: trade ? { symbol: trade.symbol, side: trade.side, amountUsd: trade.amountUsd } : null,
  });

  return {
    events,
    decision,
    trade,
    positionId,
    // A Risk Manager ELŐTTI eredeti döntés — a cron route ebből naplózza a
    // risk_overrides sort, ha a Risk Manager módosított/elutasított. Lásd spec §3.4.
    rawAction: rawDecision.action,
    rawAmountPct: rawDecision.amountPct,
    prices,
    cycleActions,
    process: tickProcess,
  };
}

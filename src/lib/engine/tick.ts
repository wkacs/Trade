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
import { getPerformanceSummary } from "@/lib/portfolio/evaluate";
import { evaluatePosition } from "@/lib/strategy/position-actions";
import { evaluateDca } from "@/lib/strategy/fear-greedy";
import { remainingWeeklyBudget } from "@/lib/strategy/weekly-budget";
import { ratchetStop } from "@/lib/strategy/trailing-stop";
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
  amountUsd: number;
  qty: number;
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
    // 1+2) Stop-loss + take-profit minden nyitott pozícióra (a stop elsőbbséget élvez).
    //      A stop-loss felszabadít cash-t, ami a DCA-nál hasznosul — ezért fut előbb.
    for (const p of [...workingPositions]) {
      const currentPrice = prices[p.symbol];
      if (currentPrice === undefined) continue;

      // TRAILING STOP (ratchet): az értékelés ELŐTT kússzon a stop felfelé, ha az ár
      // emelkedett — így egy későbbi visszaesés a MAGASABB stopon tüzel, és védi a már
      // megszerzett nyereséget (nem csak a belépő -5%-án). A ratchet eredményét a DB-be
      // is perzisztáljuk (setStopPrice), hogy a következő ticknél is éljen. Lásd spec §B.
      const newStop = ratchetStop(p.stopPrice, currentPrice, RISK_LIMITS.stopLossPct);
      if (newStop > p.stopPrice) {
        p.stopPrice = newStop;
        await setStopPrice(p.id, newStop);
      }

      const action = evaluatePosition({
        positionId: p.id,
        symbol: p.symbol,
        qty: p.qty,
        entryPrice: p.entryPrice,
        stopPrice: p.stopPrice,
        currentPrice,
      });
      if (action.kind === "none") continue;
      const sellQty = p.qty * action.qtyFraction;
      const trade = await executeCycleOrder("SELL", p.symbol, { qty: sellQty }, currentPrice);
      if (trade)
        cycleActions.push({
          kind: action.kind,
          side: "SELL",
          symbol: p.symbol,
          amountUsd: trade.amountUsd,
          qty: trade.qty,
        });
    }

    // 3) Fear-greedy DCA — kötelező vétel, ha a piac érték-alul (F&G ≤ küszöb).
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
    const dca = evaluateDca({
      fearGreedValue,
      coinChanges,
      weeklyBudgetRemainingUsd: weeklyRemaining,
      totalEquity: totalEquityNow(),
    });
    if (dca.shouldAccumulate && dca.symbol) {
      const px = prices[dca.symbol];
      if (px) {
        const trade = await executeCycleOrder("BUY", dca.symbol, { amountUsd: dca.amountUsd }, px);
        if (trade) {
          cycleActions.push({
            kind: "dca",
            side: "BUY",
            symbol: dca.symbol,
            amountUsd: trade.amountUsd,
            qty: trade.qty,
          });
          // Egy tickon belül ne vegyen duplán: a DCA után az AI BUY-ja a CSÖKKENTETT
          // keretet lássa a Risk Manager heti-limit kapujában. Lásd spec §3.4.
          weeklyRemaining -= trade.amountUsd;
        }
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
  }

  // 6) Risk Manager — a limitek érvényesítése az AI döntése felett. A munka-állapot
  //    (a profit-ciklus után frissített cash/pozíciók) + a maradék heti DCA-keret megy be,
  //    így a heti limit az AI BUY-jára is érvényesül (spec §3.5).
  const decision = applyRisk(rawDecision, {
    cashUsd,
    positions: workingPositions,
    totalEquity: totalEquityNow,
    dayPnlPct,
    weeklyBudgetRemainingUsd: weeklyRemaining,
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
            positions: workingPositions.map((p) => ({ symbol: p.symbol, qty: p.qty, valueUsd: p.valueUsd })),
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
    prices,
    cycleActions,
  };
}

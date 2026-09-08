import type {
  HistoryFrame,
  BacktestConfig,
  BacktestResult,
  EquityPoint,
  ClosedTradePnl,
  RealizationEvent,
  EntryEvent,
  ExecutionModel,
} from "./types";
import { planProfitCycle, computeAllSignals } from "@/lib/engine/profit-cycle";
import { simulateFill, protectionTriggers } from "./fill-sim";
import { computeMetrics } from "./metrics";
import { DEFAULT_STRATEGY, type StrategyConfig } from "@/lib/strategy/config";
import { evaluateDayGate, type DayEquityRow } from "@/lib/portfolio/day-equity";
import {
  emptyLedger,
  applyFill,
  setStop,
  cashOf,
  positionQty,
  equityAt,
  type LedgerState,
} from "@/lib/portfolio/ledger";
import { evaluateOrder, type OrderRiskContext, type OrderRiskParams } from "@/lib/risk/risk-manager";
import { fillKey, type Fill } from "@/lib/execution/contracts";
import { dec, toNumber, mul, div, isPositive, type Dec } from "@/lib/portfolio/money";

const HOUR = 3600_000;
const PORTFOLIO_ID = "backtest";
const QUOTE = "USDT";

/** Egy következő gyertyára ütemezett order (nincs look-ahead). */
interface PendingOrder {
  kind: "stop-loss" | "take-profit" | "dca" | "momentum" | "ai";
  side: "BUY" | "SELL";
  symbol: string;
  qty?: number;
  amountUsd?: number;
  triggerPrice?: number;
}

/**
 * Lebegőpontos szám → `Dec` a backteszt határán.
 *
 * A szimulátor `number`-ekkel dolgozik, és egy osztás eredménye simán lehet 19+
 * tizedesjegy (pl. 0.0015675382806377555). A `dec()` ilyet — helyesen — elutasít, mert
 * a könyvelés 18 tizedes fixpontos. A backteszt tehát ITT vág, a könyvelés ELŐTT, hogy
 * a hiba ne egy futás közepén, kiszámíthatatlan helyen dobjon.
 *
 * A vágás CSONKOLÁS (nem kerekítés): a 18. tizedes utáni maradékot eldobjuk, tehát
 * soha nem könyvelünk többet, mint amennyi ténylegesen van.
 */
function decFloat(n: number): Dec {
  if (!Number.isFinite(n)) throw new Error(`decFloat: nem véges szám (${n})`);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  // 20 tizedesre írjuk ki, majd 18-ra CSONKOLUNK — a toFixed(18) kerekítene.
  const [intPart, frac = ""] = abs.toFixed(20).split(".");
  const truncated = frac.slice(0, 18).replace(/0+$/, "");
  return dec(truncated ? `${sign}${intPart}.${truncated}` : `${sign}${intPart}`);
}

/**
 * Determinisztikus backtest (T17) — a runTick KÖZÖS kapuját (evaluateOrder) és KÖZÖS
 * könyvelőjét (ledger.applyFill) futtatja történelmi kereteken.
 *
 * Amit az audit §7-hez képest javít:
 *  - NINCS look-ahead: a jel a LEZÁRT gyertyából születik, és a KÖVETKEZŐ gyertya
 *    nyitóján teljesül. A régi kód ugyanannak a gyertyának a záróján vett, miután
 *    látta a gyertya high/low-ját.
 *  - A `polling` és az `exchange-stop` mód KÜLÖN modell: a futó bot óránként egy
 *    pillanatképet lát, nem a gyertyán belüli mélypontot.
 *  - Minden order ugyanazon a kockázati kapun megy át, mint élesben, és ugyanaz a
 *    fill-könyvelő számolja a készpénzt, a készletet és a díjat.
 *  - A RÉSZLEGES realizálások is bekerülnek a statisztikába.
 *
 * Tiszta a hálózat felé — a history-t a hívó tölti be. Nincs Date.now/IO.
 */
export function runBacktest(
  history: HistoryFrame[],
  config: BacktestConfig,
  strategy: StrategyConfig = DEFAULT_STRATEGY,
): BacktestResult {
  const frames = [...history].sort((a, b) => a.ts - b.ts);
  const model: ExecutionModel = config.executionModel ?? "polling";
  const riskParams: OrderRiskParams = {
    maxPositionPct: dec(strategy.maxPositionPct),
    maxConcurrentPositions: strategy.maxConcurrentPositions,
    minOrderQuote: dec(config.minOrderQuote ?? 1),
    feeReservePct: dec(config.feePct),
  };

  let ledger: LedgerState = emptyLedger(PORTFOLIO_ID, "paper", dec(config.initialCapitalUsd), QUOTE);
  const equity: EquityPoint[] = [];
  const realizations: RealizationEvent[] = [];
  const entries: EntryEvent[] = [];
  const closedTrades: ClosedTradePnl[] = [];
  const rejections: Record<string, number> = {};
  // Gördülő heti keret. Az `origin` és a BRUTTÓ érték azért kell külön, mert a heti
  // DCA-keretet a futó rendszer csak a dca-eredetű vételek bruttó értékéből számolja.
  const buyLog: { ts: number; amountUsd: number; grossUsd: number; origin: PendingOrder["kind"] }[] = [];
  const buffers: Record<string, { openTime: number; high: number; low: number; close: number }[]> = {};
  /** Az előző keretben megtervezett, MOST végrehajtandó orderek. */
  let pending: PendingOrder[] = [];
  let hoursInMarket = 0;
  let fillSeq = 0;

  /**
   * Ár-térkép a keretből. Az `at` dönti el, MELYIK árat ismerjük már (audit 4. pont): a
   * bar nyitóján végrehajtott order idején a záróár MÉG NEM LÉTEZIK, tehát vele sem
   * értékelni, sem keretet számolni nem szabad.
   */
  const priceMap = (frame: HistoryFrame, at: "open" | "close" = "close"): Record<string, Dec> => {
    const out: Record<string, Dec> = {};
    for (const sym of config.symbols) {
      const k = frame.candles[sym];
      if (k) out[sym] = decFloat(at === "open" ? k.open : k.close);
    }
    return out;
  };

  /**
   * NAPI VESZTESÉGKAPU a backtesztben — ugyanaz a tiszta szabály, amit a futó tick a
   * DB-vel futtat (audit 6. pont). Enélkül a backteszt olyan vételeket számolna hozamnak,
   * amiket az éles rendszer a napi latch miatt meg sem kötne.
   */
  let dayRow: DayEquityRow | null = null;
  const dayGateAt = (nowMs: number, equity: Dec | null): { latched: boolean; baselineMissing: boolean } => {
    const gate = evaluateDayGate({
      nowMs,
      row: dayRow,
      currentEquity: equity,
      thresholdPct: dec(strategy.dailyLossCircuitBreakerPct),
    });
    dayRow = gate.row;
    return { latched: gate.latched, baselineMissing: gate.dayPnlPct === null };
  };

  /**
   * A DCA heti költése — CSAK a `dca` eredetű vétel, BRUTTÓ fill-értéken, pontosan úgy,
   * ahogy a futó rendszer `spentThisWeekUsd`-je számol (audit 6. pont). A momentum-vétel
   * nem fogyaszthatja a DCA keretét.
   */
  const dcaSpent7d = (nowTs: number): number =>
    buyLog
      .filter((b) => b.origin === "dca" && b.ts > nowTs - 7 * 24 * HOUR)
      .reduce((sum, b) => sum + b.grossUsd, 0);

  const riskContext = (
    frame: HistoryFrame,
    originBudget?: Dec,
    at: "open" | "close" = "close",
  ): OrderRiskContext => {
    const prices = priceMap(frame, at);
    // Ha egy BIRTOKOLT papírra nincs ár ebben a keretben, az equity NEM MÉRHETŐ: `null`
    // megy tovább, nem egy hiányos összeg. Enélkül a hiányzó gyertya úgy látszana, mintha
    // a pozíció nullát érne — hamis napi veszteséget latch-elve.
    const unpricedHeld = Object.values(ledger.positions).some(
      (p) => isPositive(p.qty) && prices[p.symbol] === undefined,
    );
    const gate = dayGateAt(frame.ts, unpricedHeld ? null : equityAt(ledger, prices, QUOTE));
    return {
      ledger,
      prices,
      reservedQuoteBySymbol: {},
      reservedQuoteTotal: "0",
      originBudgetQuote: originBudget,
      dailyLossLatched: gate.latched,
      dayBaselineMissing: gate.baselineMissing,
      allowedSymbols: config.symbols,
      quoteAsset: QUOTE,
    };
  };

  /** Egy szimulált fill elkönyvelése a KÖZÖS ledgerrel. */
  const book = (
    frame: HistoryFrame,
    symbol: string,
    side: "BUY" | "SELL",
    sim: { fillPrice: number; qty: number; amountUsd: number; feeUsd: number },
    kind: PendingOrder["kind"],
    stopPrice: Dec | null,
  ): boolean => {
    const orderId = `bt-${++fillSeq}`;
    const fill: Fill = {
      fillId: fillKey("paper", orderId, "1"),
      intentId: orderId,
      portfolioId: PORTFOLIO_ID,
      mode: "paper",
      symbol,
      side,
      exchangeOrderId: orderId,
      exchangeTradeId: "1",
      filledBaseQty: decFloat(sim.qty),
      grossQuoteAmount: decFloat(sim.amountUsd),
      fillPrice: decFloat(sim.fillPrice),
      feeAmount: decFloat(sim.feeUsd),
      feeAsset: QUOTE,
      executedAt: frame.ts,
    };
    const before = ledger.positions[symbol];
    const costBasisBefore = before?.costBasisQuote ?? "0";
    const qtyBefore = before?.qty ?? "0";

    const result = applyFill(ledger, fill, {
      quoteAsset: QUOTE,
      ...(side === "BUY" && stopPrice !== null ? { stopPrice } : {}),
    });
    if (!result.applied) return false;
    ledger = result.state;

    if (side === "SELL") {
      const closes = !ledger.positions[symbol];
      const costBasisUsed = isPositive(qtyBefore)
        ? toNumber(mul(costBasisBefore, div(decFloat(sim.qty), qtyBefore)))
        : 0;
      realizations.push({
        ts: frame.ts,
        symbol,
        qty: sim.qty,
        exitPrice: sim.fillPrice,
        pnlUsd: toNumber(result.realizedPnlQuote),
        costBasisUsd: costBasisUsed,
        feeUsd: sim.feeUsd,
        closesPosition: closes,
        kind: kind === "stop-loss" || kind === "take-profit" ? kind : "market",
      });
      if (closes) {
        const entryPrice = isPositive(qtyBefore) ? toNumber(div(costBasisBefore, qtyBefore)) : sim.fillPrice;
        closedTrades.push({
          symbol,
          entryPrice,
          exitPrice: sim.fillPrice,
          qty: sim.qty,
          pnlUsd: toNumber(result.realizedPnlQuote),
          pnlPct: costBasisUsed > 0 ? toNumber(result.realizedPnlQuote) / costBasisUsed : 0,
        });
      }
    } else {
      buyLog.push({ ts: frame.ts, amountUsd: sim.amountUsd + sim.feeUsd, grossUsd: sim.amountUsd, origin: kind });
      entries.push({
        ts: frame.ts,
        symbol,
        qty: sim.qty,
        fillPrice: sim.fillPrice,
        amountUsd: sim.amountUsd,
        feeUsd: sim.feeUsd,
        kind: kind === "dca" || kind === "momentum" ? kind : "ai",
      });
    }
    return true;
  };

  const reject = (code: string) => {
    rejections[code] = (rejections[code] ?? 0) + 1;
  };

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];

    // ── 0) NAPI KAPU MINDEN KERETBEN. A futó tick minden ciklusban kiértékeli, ezért a
    //    napkezdő referencia a nap ELSŐ bárján rögzül, és a latch akkor is bekapcsol, ha
    //    aznap egyetlen order sem futott. Ha ezt csak az order-értékeléshez kötnénk, egy
    //    esemény nélküli nap után a baseline a zuhanás UTÁNI equityből születne, és a
    //    backteszt olyan vételt engedne át, amit az éles rendszer letiltana.
    {
      const openPrices = priceMap(frame, "open");
      const unpricedHeld = Object.values(ledger.positions).some(
        (p) => isPositive(p.qty) && openPrices[p.symbol] === undefined,
      );
      dayGateAt(frame.ts, unpricedHeld ? null : equityAt(ledger, openPrices, QUOTE));
    }

    // ── 1) A tőzsdén ÜLŐ védőorderek: a gyertyán belül is tüzelhetnek. ────────
    if (model === "exchange-stop") {
      for (const symbol of Object.keys(ledger.positions)) {
        const k = frame.candles[symbol];
        const pos = ledger.positions[symbol];
        if (!k || !pos) continue;
        const entry = isPositive(pos.qty) ? toNumber(div(pos.costBasisQuote, pos.qty)) : 0;
        const tp = entry > 0 ? entry * (1 + strategy.takeProfitPct) : null;
        const trigger = protectionTriggers(k, pos.stopPrice ? toNumber(pos.stopPrice) : null, tp, model);
        if (!trigger) continue;
        const qty = toNumber(pos.qty) * (trigger === "take-profit" ? strategy.takeProfitFraction : 1);
        const sim = simulateFill(
          {
            side: "SELL",
            kind: trigger,
            model,
            qty,
            triggerPrice: trigger === "stop-loss" ? toNumber(pos.stopPrice ?? "0") : tp ?? undefined,
            candle: k,
          },
          config.feePct,
          config.slippageBps,
        );
        if (sim) book(frame, symbol, "SELL", sim, trigger, null);
      }
    }

    // ── 2) Az ELŐZŐ keretben tervezett orderek végrehajtása a MOSTANI nyitón. ──
    for (const order of pending) {
      const k = frame.candles[order.symbol];
      if (!k) {
        reject("no_candle");
        continue;
      }
      if (order.side === "SELL") {
        const verdict = evaluateOrder(
          { side: "SELL", symbol: order.symbol, baseQty: decFloat(order.qty ?? 0) },
          riskContext(frame, undefined, "open"),
          riskParams,
        );
        if (!verdict.allowed) {
          reject(verdict.code);
          continue;
        }
        const qty = toNumber(verdict.order.side === "SELL" ? verdict.order.baseQty : "0");
        const sim = simulateFill(
          {
            side: "SELL",
            kind: order.kind === "stop-loss" || order.kind === "take-profit" ? order.kind : "market",
            model,
            qty,
            triggerPrice: order.triggerPrice,
            candle: k,
            at: "open",
          },
          config.feePct,
          config.slippageBps,
        );
        if (sim) book(frame, order.symbol, "SELL", sim, order.kind, null);
      } else {
        // A keret és a kockázat a NYITÓ árakból (audit 4.), a költés csak dca-ból (audit 6.).
        const weeklyRemaining = Math.max(
          0,
          strategy.dcaWeeklyBudgetPct * toNumber(equityAt(ledger, priceMap(frame, "open"), QUOTE)) -
            dcaSpent7d(frame.ts),
        );
        const originBudget = order.kind === "dca" ? decFloat(weeklyRemaining) : undefined;
        const verdict = evaluateOrder(
          { side: "BUY", symbol: order.symbol, desiredQuote: decFloat(order.amountUsd ?? 0) },
          riskContext(frame, originBudget, "open"),
          riskParams,
        );
        if (!verdict.allowed) {
          reject(verdict.code);
          continue;
        }
        const budget = toNumber(verdict.order.side === "BUY" ? verdict.order.maxQuoteSpend : "0");
        const sim = simulateFill(
          { side: "BUY", kind: "market", model, amountUsd: budget, candle: k, at: "open" },
          config.feePct,
          config.slippageBps,
        );
        if (!sim) {
          reject("no_fill");
          continue;
        }
        const atr = buffers[order.symbol]
          ? computeAllSignals({ [order.symbol]: buffers[order.symbol] }, strategy, HOUR)[order.symbol].atr
          : 0;
        const stopPrice =
          strategy.stopMode === "atr" && atr > 0
            ? decFloat(sim.fillPrice - strategy.atrMult * atr)
            : decFloat(sim.fillPrice * (1 - strategy.stopLossPct));
        book(frame, order.symbol, "BUY", sim, order.kind, stopPrice);
      }
    }
    pending = [];

    // ── 3) Jelek és terv a MOSTANI, LEZÁRT gyertyából. ───────────────────────
    for (const sym of config.symbols) {
      const k = frame.candles[sym];
      if (!k) continue;
      const buf = (buffers[sym] ??= []);
      buf.push({ openTime: frame.ts, high: k.high, low: k.low, close: k.close });
      if (buf.length > 300) buf.shift();
    }
    const signals = computeAllSignals(buffers, strategy, HOUR);
    const atrBySymbol: Record<string, number> = {};
    const trendOkBySymbol: Record<string, boolean> = {};
    const momentumOkBySymbol: Record<string, boolean> = {};
    for (const [sym, sig] of Object.entries(signals)) {
      atrBySymbol[sym] = sig.atr;
      trendOkBySymbol[sym] = sig.trendOk;
      momentumOkBySymbol[sym] = sig.momentumOk;
    }

    const prices = priceMap(frame);
    const totalEquity = toNumber(equityAt(ledger, prices, QUOTE));
    if (Object.keys(ledger.positions).length > 0) hoursInMarket++;

    const weeklyRemaining = Math.max(0, strategy.dcaWeeklyBudgetPct * totalEquity - dcaSpent7d(frame.ts));

    const prevFrame = frames[fi - 24];
    const coinChanges = config.symbols.map((sym) => {
      const now = frame.candles[sym]?.close;
      const before = prevFrame ? prevFrame.candles[sym]?.close : undefined;
      return { symbol: sym, change24hPct: now && before ? ((now - before) / before) * 100 : 0 };
    });

    // A polling modell a MEGFIGYELT árat látja: low=high=close (nem a gyertyán belüli szél).
    const candles: Record<string, { low: number; high: number; close: number }> = {};
    for (const sym of config.symbols) {
      const k = frame.candles[sym];
      if (!k) continue;
      candles[sym] =
        model === "exchange-stop"
          ? { low: k.low, high: k.high, close: k.close }
          : { low: k.close, high: k.close, close: k.close };
    }

    const plan = planProfitCycle(
      {
        positions: Object.values(ledger.positions).map((p) => ({
          id: p.symbol,
          symbol: p.symbol,
          qty: toNumber(p.qty),
          entryPrice: isPositive(p.qty) ? toNumber(div(p.costBasisQuote, p.qty)) : 0,
          stopPrice: p.stopPrice ? toNumber(p.stopPrice) : 0,
        })),
        candles,
        fearGreedValue: frame.fearGreedValue,
        coinChanges,
        weeklyBudgetRemainingUsd: weeklyRemaining,
        totalEquity,
        atrBySymbol,
        trendOkBySymbol,
        momentumOkBySymbol,
      },
      strategy,
    );

    // Trailing ratchet: a stop a KÖVETKEZŐ gyertyára érvényes.
    for (const u of plan.stopUpdates) {
      if (ledger.positions[u.positionId]) ledger = setStop(ledger, u.positionId, decFloat(u.newStop));
    }

    // Az `exchange-stop` modellben a védőordert már az 1) lépés kezeli, ezért innen
    // csak a NEM védelmi orderek kerülnek sorba. A `polling` modellben minden ide jön.
    for (const o of plan.orders) {
      const isProtection = o.kind === "stop-loss" || o.kind === "take-profit";
      if (model === "exchange-stop" && isProtection) continue;
      pending.push({
        kind: o.kind,
        side: o.side,
        symbol: o.symbol,
        qty: o.qty,
        amountUsd: o.amountUsd,
        triggerPrice: o.triggerPrice,
      });
    }
    // SELL-ek előbb: a felszabaduló készpénz a következő keretben a BUY-nak hasznosul.
    pending.sort((a, b) => (a.side === b.side ? 0 : a.side === "SELL" ? -1 : 1));

    equity.push({ ts: frame.ts, equityUsd: toNumber(equityAt(ledger, prices, QUOTE)) });
  }

  const totalFeesUsd = realizations.reduce((s, r) => s + r.feeUsd, 0);
  const samplingHours =
    frames.length > 1 ? Math.max(1, Math.round((frames[1].ts - frames[0].ts) / HOUR)) : 1;

  return {
    metrics: computeMetrics(equity, realizations, hoursInMarket, { samplingHours, buyFeesUsd: buyFeeTotal(buyLog, config.feePct) + totalFeesUsd }),
    equityCurve: equity,
    closedTrades,
    realizations,
    entries,
    config,
    from: frames[0]?.ts ?? 0,
    to: frames[frames.length - 1]?.ts ?? 0,
    rejections,
  };
}

/** A vételi díjak összege (a buyLog a díjjal együtti költést tárolja). */
function buyFeeTotal(buyLog: { amountUsd: number }[], feePct: number): number {
  return buyLog.reduce((s, b) => s + (b.amountUsd * feePct) / (1 + feePct), 0);
}

/** Segéd a paritás-teszthez: a backtest ledger-állapota a futás végén. */
export function backtestFinalCash(result: BacktestResult): number {
  return result.equityCurve.length > 0 ? result.equityCurve[result.equityCurve.length - 1].equityUsd : 0;
}

export { cashOf, positionQty };

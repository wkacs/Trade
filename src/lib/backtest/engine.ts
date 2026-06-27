import type {
  HistoryFrame,
  BacktestConfig,
  BacktestResult,
  EquityPoint,
  ClosedTradePnl,
} from "./types";
import { planProfitCycle } from "@/lib/engine/profit-cycle";
import { simulateFill } from "./fill-sim";
import { computeMetrics } from "./metrics";
import { PROFIT_CYCLE, RISK_LIMITS } from "@/lib/config";

interface SimPosition {
  id: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice: number;
}

const HOUR = 3600_000;

/**
 * Determinisztikus backtest: a runTick profit-ciklusát (a közös planProfitCycle-t)
 * futtatja történelmi kereteken, gyertya-fill szimulációval. Policy = HOLD (LLM kívül;
 * a belépők a kód-alapú DCA-ból jönnek). Tiszta a hálózat felé — a history-t a hívó
 * tölti be (data.ts). Nincs Date.now/IO. Lásd backtest spec.
 */
export function runBacktest(history: HistoryFrame[], config: BacktestConfig): BacktestResult {
  const frames = [...history].sort((a, b) => a.ts - b.ts);
  let cashUsd = config.initialCapitalUsd;
  let positions: SimPosition[] = [];
  const equity: EquityPoint[] = [];
  const closedTrades: ClosedTradePnl[] = [];
  const buyLog: { ts: number; amountUsd: number }[] = []; // gördülő heti keret
  let hoursInMarket = 0;
  let nextId = 1;

  const closeAt = (frame: HistoryFrame, sym: string): number | undefined => frame.candles[sym]?.close;
  const equityNow = (frame: HistoryFrame): number =>
    cashUsd + positions.reduce((s, p) => s + (closeAt(frame, p.symbol) ?? p.entryPrice) * p.qty, 0);

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];

    // Mark-to-market equity (cash + pozíciók close-on).
    const totalEquity = equityNow(frame);
    if (positions.length > 0) hoursInMarket++;

    // Heti DCA-keret: dcaWeeklyBudgetPct * equity − az utolsó 7 nap BUY-jai.
    const weekAgo = frame.ts - 7 * 24 * HOUR;
    const spent7d = buyLog.filter((b) => b.ts > weekAgo).reduce((s, b) => s + b.amountUsd, 0);
    const weeklyRemaining = Math.max(0, PROFIT_CYCLE.dcaWeeklyBudgetPct * totalEquity - spent7d);

    // 24h változás a close-okból (24 frame-mel korábbi close).
    const prevFrame = frames[fi - 24];
    const coinChanges = config.symbols.map((sym) => {
      const now = closeAt(frame, sym);
      const before = prevFrame ? closeAt(prevFrame, sym) : undefined;
      const change24hPct = now && before ? ((now - before) / before) * 100 : 0;
      return { symbol: sym, change24hPct };
    });

    // Candle-band a planhez.
    const candles: Record<string, { low: number; high: number; close: number }> = {};
    for (const sym of config.symbols) {
      const k = frame.candles[sym];
      if (k) candles[sym] = { low: k.low, high: k.high, close: k.close };
    }

    const plan = planProfitCycle({
      positions: positions.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        qty: p.qty,
        entryPrice: p.entryPrice,
        stopPrice: p.stopPrice,
      })),
      candles,
      fearGreedValue: frame.fearGreedValue,
      coinChanges,
      weeklyBudgetRemainingUsd: weeklyRemaining,
      totalEquity,
      stopLossPct: RISK_LIMITS.stopLossPct,
    });

    // Stop-update-ek (trailing ratchet → következő gyertya stopja).
    for (const u of plan.stopUpdates) {
      const pos = positions.find((p) => p.id === u.positionId);
      if (pos) pos.stopPrice = u.newStop;
    }

    // Orderek: SELL-ek előbb (a felszabaduló cash a DCA-nak), majd BUY-ok.
    const sells = plan.orders.filter((o) => o.side === "SELL");
    const buys = plan.orders.filter((o) => o.side === "BUY");
    for (const o of [...sells, ...buys]) {
      const k = frame.candles[o.symbol];
      if (!k) continue;

      if (o.side === "SELL") {
        const pos = positions.find((p) => p.symbol === o.symbol);
        if (!pos) continue;
        const fill = simulateFill(
          {
            side: "SELL",
            kind: o.kind === "dca" ? "market" : o.kind,
            qty: Math.min(o.qty ?? 0, pos.qty),
            triggerPrice: o.triggerPrice,
            candle: k,
          },
          config.feePct,
          config.slippageBps,
        );
        if (!fill) continue;
        cashUsd += fill.amountUsd - fill.feeUsd;
        pos.qty -= fill.qty;
        // Lezárt-e (teljes stop) → realizált PnL.
        if (pos.qty <= 1e-7) {
          closedTrades.push({
            symbol: pos.symbol,
            entryPrice: pos.entryPrice,
            exitPrice: fill.fillPrice,
            qty: fill.qty,
            pnlUsd: (fill.fillPrice - pos.entryPrice) * fill.qty,
            pnlPct: (fill.fillPrice - pos.entryPrice) / pos.entryPrice,
          });
          positions = positions.filter((p) => p !== pos);
        }
      } else {
        // BUY (DCA) — clamp a cash-re.
        const amountUsd = Math.min(o.amountUsd ?? 0, Math.max(0, cashUsd));
        if (amountUsd <= 0) continue;
        const fill = simulateFill({ side: "BUY", kind: "market", amountUsd, candle: k }, config.feePct, config.slippageBps);
        if (!fill) continue;
        cashUsd -= amountUsd;
        buyLog.push({ ts: frame.ts, amountUsd });
        const ex = positions.find((p) => p.symbol === o.symbol);
        if (ex) {
          const newQty = ex.qty + fill.qty;
          ex.entryPrice = (ex.qty * ex.entryPrice + fill.qty * fill.fillPrice) / newQty;
          ex.qty = newQty;
          ex.stopPrice = fill.fillPrice * (1 - RISK_LIMITS.stopLossPct);
        } else {
          positions.push({
            id: String(nextId++),
            symbol: o.symbol,
            qty: fill.qty,
            entryPrice: fill.fillPrice,
            stopPrice: fill.fillPrice * (1 - RISK_LIMITS.stopLossPct),
          });
        }
      }
    }

    // Policy = HOLD (MVP) — nincs AI-belépő. A P2 ML-policy seam ide jön (applyRisk +
    // buildFeatures/predict az AI BUY/SELL döntéshez); az MVP-ben szándékosan kihagyva.

    equity.push({ ts: frame.ts, equityUsd: equityNow(frame) });
  }

  return {
    metrics: computeMetrics(equity, closedTrades, hoursInMarket),
    equityCurve: equity,
    closedTrades,
    config,
    from: frames[0]?.ts ?? 0,
    to: frames[frames.length - 1]?.ts ?? 0,
  };
}

import type { StrategyConfig } from "@/lib/strategy/config";
import { evaluatePosition } from "@/lib/strategy/position-actions";
import { evaluateDca } from "@/lib/strategy/fear-greedy";
import { ratchetStop } from "@/lib/strategy/trailing-stop";

export interface PlannedOrder {
  kind: "stop-loss" | "take-profit" | "dca";
  side: "BUY" | "SELL";
  symbol: string;
  qty?: number; // SELL (stop/TP)
  amountUsd?: number; // BUY (DCA)
  triggerPrice?: number; // SELL fill-referencia
  reason: string;
}

export interface StopUpdate {
  positionId: string;
  newStop: number;
}

export interface ProfitCyclePlan {
  orders: PlannedOrder[];
  stopUpdates: StopUpdate[];
}

export interface ProfitCycleInput {
  positions: { id: string; symbol: string; qty: number; entryPrice: number; stopPrice: number }[];
  candles: Record<string, { low: number; high: number; close: number }>;
  fearGreedValue: number | null;
  coinChanges: { symbol: string; change24hPct: number }[];
  weeklyBudgetRemainingUsd: number;
  totalEquity: number;
  /** Per-symbol ATR (a hívó számolja). atr módban a stop-távolsághoz; fixed módban ignorált. */
  atrBySymbol: Record<string, number>;
  /** Per-symbol trend-flag (close ≥ SMA). trend módban a DCA-jogosultsághoz; off módban ignorált. */
  trendOkBySymbol: Record<string, boolean>;
}

/**
 * A kód-alapú profit-ciklus DÖNTÉS-része, tisztán (nincs IO/DB/Date.now). A stratégiát
 * a `config` (StrategyConfig) vezérli. Sorrend (a runTick tükre): stop/TP az eredeti
 * stoppal → trailing ratchet (mód szerint) → DCA (szűrővel).
 * A hívó hajtja végre az ordereket + perzisztálja a stopUpdate-eket.
 */
export function planProfitCycle(input: ProfitCycleInput, config: StrategyConfig): ProfitCyclePlan {
  const orders: PlannedOrder[] = [];
  const stopUpdates: StopUpdate[] = [];

  for (const p of input.positions) {
    const candle = input.candles[p.symbol];
    if (!candle) continue;

    // 1) Stop/TP az EREDETI (előző gyertyából hozott) stoppal — NINCS look-ahead.
    const action = evaluatePosition(
      {
        positionId: p.id,
        symbol: p.symbol,
        qty: p.qty,
        entryPrice: p.entryPrice,
        stopPrice: p.stopPrice,
        low: candle.low,
        high: candle.high,
        close: candle.close,
      },
      { takeProfitPct: config.takeProfitPct, takeProfitFraction: config.takeProfitFraction },
    );
    if (action.kind !== "none") {
      orders.push({
        kind: action.kind,
        side: "SELL",
        symbol: p.symbol,
        qty: p.qty * action.qtyFraction,
        triggerPrice: action.triggerPrice,
        reason: action.reason,
      });
    }

    // 2) Trailing ratchet → a KÖVETKEZŐ gyertya stopja. Mód szerint a stop-távolság:
    //    atr → close − atrMult*ATR; fixed → close*(1−stopLossPct). Csak felfelé kúszik.
    const atr = input.atrBySymbol[p.symbol] ?? 0;
    const candidate =
      config.stopMode === "atr" && atr > 0
        ? candle.close - config.atrMult * atr
        : candle.close * (1 - config.stopLossPct);
    const newStop = ratchetStop(p.stopPrice, candidate, 0); // pct=0 → max(prevStop, candidate)
    if (newStop > p.stopPrice) stopUpdates.push({ positionId: p.id, newStop });
  }

  // 3) Fear-greedy DCA (config + belépő-szűrő).
  const dca = evaluateDca(
    {
      fearGreedValue: input.fearGreedValue,
      coinChanges: input.coinChanges,
      weeklyBudgetRemainingUsd: input.weeklyBudgetRemainingUsd,
      totalEquity: input.totalEquity,
      trendOkBySymbol: input.trendOkBySymbol,
    },
    {
      dcaFgThreshold: config.dcaFgThreshold,
      dcaMax24hDropPct: config.dcaMax24hDropPct,
      dcaBuyPct: config.dcaBuyPct,
      entryFilter: config.entryFilter,
    },
  );
  if (dca.shouldAccumulate && dca.symbol) {
    orders.push({
      kind: "dca",
      side: "BUY",
      symbol: dca.symbol,
      amountUsd: dca.amountUsd,
      reason: dca.reason,
    });
  }

  return { orders, stopUpdates };
}

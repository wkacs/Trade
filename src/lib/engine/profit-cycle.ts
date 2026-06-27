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
  stopLossPct: number;
}

/**
 * A kód-alapú profit-ciklus DÖNTÉS-része, tisztán (nincs IO/DB/Date.now).
 * Sorrend (a runTick tükre): trailing ratchet (close-alapú) → stop/TP → DCA.
 * A hívó hajtja végre az ordereket (cash/pozíció-mutáció) + perzisztálja a stopUpdate-eket.
 */
export function planProfitCycle(input: ProfitCycleInput): ProfitCyclePlan {
  const orders: PlannedOrder[] = [];
  const stopUpdates: StopUpdate[] = [];

  for (const p of input.positions) {
    const candle = input.candles[p.symbol];
    if (!candle) continue;

    // 1) Stop/TP az EREDETI (előző gyertyából hozott) stoppal — NINCS look-ahead.
    //    A ratchet (lent) csak a KÖVETKEZŐ gyertyára emeli a stopot, nem erre.
    //    Élesben low=close=spot, így a két sorrend egybeesik (a tick-tesztek zöldek).
    const action = evaluatePosition({
      positionId: p.id,
      symbol: p.symbol,
      qty: p.qty,
      entryPrice: p.entryPrice,
      stopPrice: p.stopPrice,
      low: candle.low,
      high: candle.high,
      close: candle.close,
    });
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

    // 2) Trailing ratchet a close-szal → a KÖVETKEZŐ gyertya stopja (perzisztálandó).
    const newStop = ratchetStop(p.stopPrice, candle.close, input.stopLossPct);
    if (newStop > p.stopPrice) stopUpdates.push({ positionId: p.id, newStop });
  }

  // 3) Fear-greedy DCA.
  const dca = evaluateDca({
    fearGreedValue: input.fearGreedValue,
    coinChanges: input.coinChanges,
    weeklyBudgetRemainingUsd: input.weeklyBudgetRemainingUsd,
    totalEquity: input.totalEquity,
  });
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

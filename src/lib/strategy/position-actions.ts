import { PROFIT_CYCLE } from "@/lib/config";

/**
 * Kód-alapú pozíció-kezelés: stop-loss + take-profit. Tiszta függvény — nincs DB,
 * nincs hálózat, determinisztikus, DB nélkül tesztelhető.
 * Candle-aware: a stop a gyertya LOW-jára, a TP a HIGH-jára tüzel (intra-candle).
 * Live: low=high=close=spot (degenerált band). Lásd backtest spec §5.
 * Lásd: docs/superpowers/specs/2026-06-26-profit-cycle-design.md §3.1.
 */

export interface PositionWithPrice {
  positionId: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  low: number;
  high: number;
  close: number;
}

export type PositionAction =
  | { kind: "none" }
  | { kind: "stop-loss"; side: "SELL"; qtyFraction: 1.0; triggerPrice: number; reason: string }
  | { kind: "take-profit"; side: "SELL"; qtyFraction: 0.5; triggerPrice: number; reason: string };

/**
 * Eldönti egy pozícióról, kell-e automatikus SELL.
 *  - low ≤ stopPrice → stop-loss (TELJES pozíció), triggerPrice = stopPrice.
 *  - high alapú nyereség ≥ takeProfitPct (+15%) → take-profit (a pozíció FELE),
 *    triggerPrice = entry*(1+tp).
 *  - a stop-loss ELSŐBBSÉGET élvez, ha mindkettő fennáll (konzervatív: ugyanazon a
 *    gyertyán a stop nyer).
 */
export function evaluatePosition(p: PositionWithPrice): PositionAction {
  // Stop-loss elsőbbség: a tőke védelme megelőzi a nyereség-realizálást.
  if (p.low <= p.stopPrice) {
    return {
      kind: "stop-loss",
      side: "SELL",
      qtyFraction: 1.0,
      triggerPrice: p.stopPrice,
      reason: `Stop-loss kiváltva: ${p.symbol} low ${p.low} ≤ stop ${p.stopPrice}`,
    };
  }

  const tpTrigger = p.entryPrice * (1 + PROFIT_CYCLE.takeProfitPct);
  if (p.high >= tpTrigger) {
    return {
      kind: "take-profit",
      side: "SELL",
      qtyFraction: 0.5,
      triggerPrice: tpTrigger,
      reason: `Take-profit: ${p.symbol} high elérte +${(PROFIT_CYCLE.takeProfitPct * 100).toFixed(
        0,
      )}% → a pozíció felének realizálása`,
    };
  }

  return { kind: "none" };
}

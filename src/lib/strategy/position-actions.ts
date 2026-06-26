import { PROFIT_CYCLE } from "@/lib/config";

/**
 * Kód-alapú pozíció-kezelés: stop-loss + take-profit. Tiszta függvény — nincs DB,
 * nincs hálózat, determinisztikus, DB nélkül tesztelhető.
 * Lásd: docs/superpowers/specs/2026-06-26-profit-cycle-design.md §3.1.
 */

export interface PositionWithPrice {
  positionId: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  currentPrice: number;
}

export type PositionAction =
  | { kind: "none" }
  | { kind: "stop-loss"; side: "SELL"; qtyFraction: 1.0; reason: string }
  | { kind: "take-profit"; side: "SELL"; qtyFraction: 0.5; reason: string };

/**
 * Eldönti egy pozícióról, kell-e automatikus SELL.
 *  - currentPrice ≤ stopPrice → stop-loss (TELJES pozíció eladása).
 *  - nyereség ≥ takeProfitPct (+15%) → take-profit (a pozíció FELE).
 *  - a stop-loss ELSŐBBSÉGET élvez, ha mindkettő fennáll.
 *  - egyébként none.
 */
export function evaluatePosition(p: PositionWithPrice): PositionAction {
  // Stop-loss elsőbbség: a tőke védelme megelőzi a nyereség-realizálást.
  if (p.currentPrice <= p.stopPrice) {
    return {
      kind: "stop-loss",
      side: "SELL",
      qtyFraction: 1.0,
      reason: `Stop-loss kiváltva: ${p.symbol} ára ${p.currentPrice} ≤ stop ${p.stopPrice}`,
    };
  }

  const gainPct = (p.currentPrice - p.entryPrice) / p.entryPrice;
  if (gainPct >= PROFIT_CYCLE.takeProfitPct) {
    return {
      kind: "take-profit",
      side: "SELL",
      qtyFraction: 0.5,
      reason: `Take-profit: ${p.symbol} +${(gainPct * 100).toFixed(1)}% ≥ ${(
        PROFIT_CYCLE.takeProfitPct * 100
      ).toFixed(0)}% → a pozíció felének realizálása`,
    };
  }

  return { kind: "none" };
}

/**
 * Kód-alapú pozíció-kezelés: stop-loss + take-profit. Tiszta függvény — nincs DB,
 * nincs hálózat, determinisztikus, DB nélkül tesztelhető.
 * Candle-aware: a stop a gyertya LOW-jára, a TP a HIGH-jára tüzel (intra-candle).
 * Live: low=high=close=spot (degenerált band). A take-profit szintje + frakciója configból.
 * Lásd: docs/superpowers/specs/2026-06-27-strategy-tournament-design.md §5.
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
  | { kind: "stop-loss"; side: "SELL"; qtyFraction: number; triggerPrice: number; reason: string }
  | { kind: "take-profit"; side: "SELL"; qtyFraction: number; triggerPrice: number; reason: string };

/**
 * Eldönti egy pozícióról, kell-e automatikus SELL.
 *  - low ≤ stopPrice → stop-loss (TELJES pozíció), triggerPrice = stopPrice.
 *  - high alapú nyereség ≥ tp.takeProfitPct → take-profit (a config szerinti frakció),
 *    triggerPrice = entry*(1+tp%).
 *  - a stop-loss ELSŐBBSÉGET élvez (konzervatív: ugyanazon a gyertyán a stop nyer).
 */
export function evaluatePosition(
  p: PositionWithPrice,
  tp: { takeProfitPct: number; takeProfitFraction: number },
): PositionAction {
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

  const tpTrigger = p.entryPrice * (1 + tp.takeProfitPct);
  if (p.high >= tpTrigger) {
    return {
      kind: "take-profit",
      side: "SELL",
      qtyFraction: tp.takeProfitFraction,
      triggerPrice: tpTrigger,
      reason: `Take-profit: ${p.symbol} high elérte +${(tp.takeProfitPct * 100).toFixed(0)}% → ${(
        tp.takeProfitFraction * 100
      ).toFixed(0)}% realizálás`,
    };
  }

  return { kind: "none" };
}

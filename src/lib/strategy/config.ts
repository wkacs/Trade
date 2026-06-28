/** A stratégia minden tunolható paramétere — a tournament ezt sweepeli. */
export interface StrategyConfig {
  stopMode: "fixed" | "atr";
  stopLossPct: number; // fixed mód: stop = entry*(1-stopLossPct)
  atrMult: number; // atr mód: stop = entry - atrMult*ATR
  atrPeriod: number;
  takeProfitPct: number;
  takeProfitFraction: number; // 0.5 = fél, 1.0 = teljes
  dcaFgThreshold: number;
  dcaBuyPct: number;
  dcaWeeklyBudgetPct: number;
  dcaMax24hDropPct: number;
  entryFilter: "off" | "trend";
  entryFilterSmaPeriod: number; // órák
  maxPositionPct: number;
  maxConcurrentPositions: number;
  dailyLossCircuitBreakerPct: number;
  /** Momentum-belépő (vesz az erőben). Alapból ki — backteszt-kapu után élesedik. */
  momentumEnabled: boolean;
  momentumSmaPeriod: number; // trend-SMA órák
  momentumLookback: number; // breakout-ablak órák
  momentumBuyPct: number; // flat méret, ha riskPerTradePct=0
  /** Kockázat-alapú méretezés: a tőke ennyije a kockázat trade-enként. 0 = flat (régi). */
  riskPerTradePct: number;
}

/**
 * A live stratégia — a tick ezt használja, a tournament ettől tér el.
 * Hangolva 2026-06-28 (Approach A robust tournament #1 nyertese, IS Sharpe 1.93 /
 * OOS 2.60, mindkét ablakban pozitív): a korábbi „mai" parity-defaulthoz képest
 * a trend-szűrő BE, a take-profit 10%/teljes (volt 15%/fél), a DCA fear-kapu FG20
 * (volt 25). A stop, a DCA-méret és a heti keret változatlan (nincs kockázat-növelés).
 * Lásd: docs/superpowers/specs/2026-06-28-strategy-tuning-design.md.
 */
export const DEFAULT_STRATEGY: StrategyConfig = {
  stopMode: "fixed",
  stopLossPct: 0.05,
  atrMult: 2,
  atrPeriod: 14,
  takeProfitPct: 0.1,
  takeProfitFraction: 1.0,
  dcaFgThreshold: 20,
  dcaBuyPct: 0.02,
  dcaWeeklyBudgetPct: 0.05,
  dcaMax24hDropPct: 0.08,
  entryFilter: "trend",
  entryFilterSmaPeriod: 24,
  maxPositionPct: 0.2,
  maxConcurrentPositions: 3,
  dailyLossCircuitBreakerPct: 0.03,
  momentumEnabled: false,
  momentumSmaPeriod: 24,
  momentumLookback: 48,
  momentumBuyPct: 0.02,
  riskPerTradePct: 0,
};

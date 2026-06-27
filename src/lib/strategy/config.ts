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
}

/** A MAI viselkedés (parity) — a live ezt használja, a tournament ettől tér el. */
export const DEFAULT_STRATEGY: StrategyConfig = {
  stopMode: "fixed",
  stopLossPct: 0.05,
  atrMult: 2,
  atrPeriod: 14,
  takeProfitPct: 0.15,
  takeProfitFraction: 0.5,
  dcaFgThreshold: 25,
  dcaBuyPct: 0.02,
  dcaWeeklyBudgetPct: 0.05,
  dcaMax24hDropPct: 0.08,
  entryFilter: "off",
  entryFilterSmaPeriod: 24,
  maxPositionPct: 0.2,
  maxConcurrentPositions: 3,
  dailyLossCircuitBreakerPct: 0.03,
};

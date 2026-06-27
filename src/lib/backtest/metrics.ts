import type { EquityPoint, ClosedTradePnl, BacktestMetrics } from "./types";

const HOURS_PER_YEAR = 24 * 365; // 8760 — a kripto 24/7

/** Tiszta metrika-számítás az equity-görbéből + a lezárt trade-ekből. */
export function computeMetrics(
  equity: EquityPoint[],
  closedTrades: ClosedTradePnl[],
  hoursInMarket: number,
): BacktestMetrics {
  const empty: BacktestMetrics = {
    totalReturnPct: 0,
    sharpe: 0,
    maxDrawdownPct: 0,
    hitRate: 0,
    tradesCount: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    profitFactor: 0,
    exposurePct: 0,
  };
  if (equity.length === 0) return empty;

  const first = equity[0].equityUsd;
  const last = equity[equity.length - 1].equityUsd;
  const totalReturnPct = first > 0 ? last / first - 1 : 0;

  // Órás hozamok → Sharpe (populációs szórás, rf=0, annualizált).
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].equityUsd;
    if (prev > 0) returns.push(equity[i].equityUsd / prev - 1);
  }
  let sharpe = 0;
  if (returns.length > 1) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(HOURS_PER_YEAR) : 0;
  }

  // Max drawdown.
  let peak = equity[0].equityUsd;
  let maxDd = 0;
  for (const p of equity) {
    if (p.equityUsd > peak) peak = p.equityUsd;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equityUsd) / peak);
  }

  // Trade-statisztika.
  const wins = closedTrades.filter((t) => t.pnlUsd > 0);
  const losses = closedTrades.filter((t) => t.pnlUsd < 0);
  const sumWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const sumLoss = losses.reduce((s, t) => s + t.pnlUsd, 0); // negatív
  const hitRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const profitFactor = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? Infinity : 0;

  const exposurePct = equity.length > 0 ? hoursInMarket / equity.length : 0;

  return {
    totalReturnPct,
    sharpe,
    maxDrawdownPct: maxDd,
    hitRate,
    tradesCount: closedTrades.length,
    avgWinPct,
    avgLossPct,
    profitFactor,
    exposurePct,
  };
}

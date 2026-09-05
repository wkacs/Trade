import type { EquityPoint, RealizationEvent, BacktestMetrics } from "./types";

const HOURS_PER_YEAR = 24 * 365; // 8760 — a kripto 24/7

export interface MetricsOptions {
  /** Az equity-görbe mintavételi köze órában. A Sharpe évesítése EHHEZ igazodik. */
  samplingHours?: number;
  /** Az összes díj quote-ban (vételi + eladási), a nettó eredmény ellenőrzéséhez. */
  buyFeesUsd?: number;
}

/**
 * Tiszta metrika-számítás az equity-görbéből + MINDEN realizálásból (T18).
 *
 * Az audit §7 két hibát mutatott ki:
 *  - a statisztika csak a VÉGSŐ eladást számolta, ezért a korábbi részleges
 *    profitkivételek eltűntek a hit rate-ből és a profit factorból;
 *  - a Sharpe fixen √8760-nal évesített, függetlenül a tényleges mintavételtől.
 *
 * Itt minden realizálás (részleges is) egy esemény, és az évesítés a valódi
 * időközből jön. A profit factor végtelen esete JSON-biztos: `null` + explicit jelző.
 */
export function computeMetrics(
  equity: EquityPoint[],
  realizations: RealizationEvent[],
  hoursInMarket: number,
  options: MetricsOptions = {},
): BacktestMetrics {
  const samplingHours = options.samplingHours && options.samplingHours > 0 ? options.samplingHours : 1;
  const empty: BacktestMetrics = {
    totalReturnPct: 0,
    sharpe: 0,
    maxDrawdownPct: 0,
    hitRate: 0,
    tradesCount: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    profitFactor: null,
    profitFactorInfinite: false,
    exposurePct: 0,
    totalFeesUsd: options.buyFeesUsd ?? 0,
    samplingHours,
  };
  if (equity.length === 0) return empty;

  // A kezdőtőke a LEGELSŐ pont — az első kötés ELŐTTI állapot.
  const first = equity[0].equityUsd;
  const last = equity[equity.length - 1].equityUsd;
  const totalReturnPct = first > 0 ? last / first - 1 : 0;

  // Periódushozamok → Sharpe (populációs szórás, rf=0), a TÉNYLEGES időközhöz évesítve.
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
    const periodsPerYear = HOURS_PER_YEAR / samplingHours;
    sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
  }

  // Max drawdown a mark-to-market görbéből.
  let peak = equity[0].equityUsd;
  let maxDd = 0;
  for (const p of equity) {
    if (p.equityUsd > peak) peak = p.equityUsd;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equityUsd) / peak);
  }

  // Trade-statisztika MINDEN realizálásból — a részleges zárás is számít.
  const wins = realizations.filter((t) => t.pnlUsd > 0);
  const losses = realizations.filter((t) => t.pnlUsd < 0);
  const sumWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const sumLoss = losses.reduce((s, t) => s + t.pnlUsd, 0); // negatív
  const hitRate = realizations.length > 0 ? wins.length / realizations.length : 0;
  const pctOf = (t: RealizationEvent) => (t.costBasisUsd > 0 ? t.pnlUsd / t.costBasisUsd : 0);
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + pctOf(t), 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + pctOf(t), 0) / losses.length : 0;

  // Nincs veszteség → a hányados nem értelmezhető. Explicit jelölés, nem Infinity.
  const profitFactorInfinite = sumLoss === 0 && sumWin > 0;
  const profitFactor = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : profitFactorInfinite ? null : sumWin === 0 ? null : null;

  const sellFees = realizations.reduce((s, t) => s + t.feeUsd, 0);

  return {
    totalReturnPct,
    sharpe,
    maxDrawdownPct: maxDd,
    hitRate,
    tradesCount: realizations.length,
    avgWinPct,
    avgLossPct,
    profitFactor,
    profitFactorInfinite,
    exposurePct: equity.length > 0 ? hoursInMarket / equity.length : 0,
    totalFeesUsd: options.buyFeesUsd ?? sellFees,
    samplingHours,
  };
}

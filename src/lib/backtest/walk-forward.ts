import type { HistoryFrame, BacktestResult } from "./types";

/** Idő szerinti split: első `ratio` rész = in-sample, a maradék = out-of-sample. */
export function splitHistory(
  frames: HistoryFrame[],
  ratio = 0.7,
): { inSample: HistoryFrame[]; outSample: HistoryFrame[] } {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(sorted.length * ratio);
  return { inSample: sorted.slice(0, cut), outSample: sorted.slice(cut) };
}

export interface RankedConfig<C> {
  config: C;
  is: BacktestResult;
  oos: BacktestResult;
}

/**
 * Rangsorol a configok között; min-trade kapu az OOS-on.
 * - alapból: OOS Sharpe szerint (csökkenő), holtverseny → OOS return.
 * - robust módban (overfit-rezisztens): csak IS>0 ÉS OOS>0 Sharpe, rangsor a
 *   gyengébbik (min) Sharpe szerint — így a szerencsés (negatív-IS / nyerő-OOS)
 *   configok kiesnek, és a mindkét ablakban tartó él kerül előre.
 */
export function rankConfigs<C>(
  items: RankedConfig<C>[],
  minTrades: number,
  opts: { robust?: boolean } = {},
): RankedConfig<C>[] {
  const gated = items.filter((x) => x.oos.metrics.tradesCount >= minTrades);
  if (!opts.robust) {
    return gated.sort(
      (a, b) =>
        b.oos.metrics.sharpe - a.oos.metrics.sharpe ||
        b.oos.metrics.totalReturnPct - a.oos.metrics.totalReturnPct,
    );
  }
  const robustScore = (r: RankedConfig<C>) => Math.min(r.is.metrics.sharpe, r.oos.metrics.sharpe);
  return gated
    .filter((x) => x.is.metrics.sharpe > 0 && x.oos.metrics.sharpe > 0)
    .sort(
      (a, b) =>
        robustScore(b) - robustScore(a) ||
        b.oos.metrics.totalReturnPct - a.oos.metrics.totalReturnPct,
    );
}

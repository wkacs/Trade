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

/** Rangsor OOS Sharpe szerint (csökkenő); min-trade kapu az OOS-on; holtverseny → OOS return. */
export function rankConfigs<C>(items: RankedConfig<C>[], minTrades: number): RankedConfig<C>[] {
  return items
    .filter((x) => x.oos.metrics.tradesCount >= minTrades)
    .sort(
      (a, b) =>
        b.oos.metrics.sharpe - a.oos.metrics.sharpe ||
        b.oos.metrics.totalReturnPct - a.oos.metrics.totalReturnPct,
    );
}

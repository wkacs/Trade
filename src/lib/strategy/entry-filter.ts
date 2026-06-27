/** Egyszerű mozgóátlag az utolsó `period` értékből. Tiszta. */
export function sma(values: number[], period: number): number {
  const w = values.slice(-period);
  return w.reduce((s, v) => s + v, 0) / (w.length || 1);
}

/** Trend-szűrő: igaz, ha az utolsó close ≥ SMA(period) (nem szabadeséses lefelé trend). */
export function passesTrendFilter(closes: number[], period: number): boolean {
  if (closes.length === 0) return true;
  const last = closes[closes.length - 1];
  return last >= sma(closes, period);
}

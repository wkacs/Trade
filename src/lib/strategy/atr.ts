/** Average True Range — volatilitás-mérték a gyertyákból. Tiszta. */
export function computeAtr(
  candles: { high: number; low: number; close: number }[],
  period: number,
): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const window = trs.slice(-period);
  return window.reduce((s, t) => s + t, 0) / (window.length || 1);
}

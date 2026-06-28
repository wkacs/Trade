/**
 * Momentum-belépő (vesz az erőben) — tiszta függvény. A fear-DCA (vesz a mélypontban)
 * MELLÉ egy trend-belépő, ami a felfutásokat kapja el. Kilépés a meglévő gépezeten
 * (evaluatePosition + ratchetStop). Nincs DB / hálózat / Date.now.
 */
import { sizeEntry } from "@/lib/strategy/sizing";

export interface MomentumSignal {
  shouldEnter: boolean;
  symbol: string | null;
  amountUsd: number;
  reason: string;
}

export interface MomentumContext {
  momentumOkBySymbol: Record<string, boolean>;
  coinChanges: { symbol: string; change24hPct: number }[];
  heldSymbols: string[];
  openPositionCount: number;
  totalEquity: number;
}

export interface MomentumParams {
  momentumEnabled: boolean;
  momentumBuyPct: number;
  maxConcurrentPositions: number;
  riskPerTradePct: number;
  stopLossPct: number;
  stopMode: "fixed" | "atr";
  maxPositionPct: number;
}

/** Breakout a trend fölött: utolsó close > SMA ÉS = az utolsó `lookback` close maximuma. */
export function passesMomentum(closes: number[], smaPeriod: number, lookback: number): boolean {
  if (closes.length < Math.max(smaPeriod, lookback)) return false;
  const last = closes[closes.length - 1];
  const sma = closes.slice(-smaPeriod).reduce((s, c) => s + c, 0) / smaPeriod;
  const window = closes.slice(-lookback);
  const high = Math.max(...window);
  return last > sma && last >= high;
}

const none = (reason: string): MomentumSignal => ({ shouldEnter: false, symbol: null, amountUsd: 0, reason });

export function evaluateMomentum(ctx: MomentumContext, params: MomentumParams): MomentumSignal {
  if (!params.momentumEnabled) return none("Momentum-belépő kikapcsolva.");
  if (ctx.openPositionCount >= params.maxConcurrentPositions)
    return none(`Max egyidejű pozíció (${params.maxConcurrentPositions}) elérve.`);

  const held = new Set(ctx.heldSymbols);
  const eligible = ctx.coinChanges.filter(
    (c) => ctx.momentumOkBySymbol[c.symbol] === true && !held.has(c.symbol),
  );
  if (eligible.length === 0) return none("Nincs jogosult momentum-coin.");

  const pick = eligible.reduce((best, c) => (c.change24hPct > best.change24hPct ? c : best));
  const amountUsd = sizeEntry(ctx.totalEquity, {
    riskPerTradePct: params.riskPerTradePct,
    stopLossPct: params.stopLossPct,
    stopMode: params.stopMode,
    maxPositionPct: params.maxPositionPct,
    flatPct: params.momentumBuyPct,
  });
  return {
    shouldEnter: true,
    symbol: pick.symbol,
    amountUsd,
    reason: `Momentum-breakout → ${pick.symbol} (${pick.change24hPct.toFixed(1)}% 24h).`,
  };
}

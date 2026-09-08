/**
 * Momentum-belépő (vesz az erőben) — tiszta függvény. A fear-DCA (vesz a mélypontban)
 * MELLÉ egy trend-belépő, ami a felfutásokat kapja el. Kilépés a meglévő gépezeten
 * (evaluatePosition + ratchetStop). Nincs DB / hálózat / Date.now.
 */
import { sizeEntry } from "@/lib/strategy/sizing";
import { rawRank, type MomentumRanker } from "@/lib/strategy/momentum-ranking";

export interface MomentumSignal {
  shouldEnter: boolean;
  symbol: string | null;
  amountUsd: number;
  reason: string;
}

export interface MomentumContext {
  momentumOkBySymbol: Record<string, boolean>;
  /**
   * A jelöltek periódus-változása. Az `atrPct` (ATR az árhoz mérten) és a
   * `benchmarkChangePct` (a piac ugyanezen periódusú elmozdulása) OPCIONÁLIS: a nyers
   * rangsornak nem kell, a kockázat-korrigált és a relatív-erő rangsornak igen. A hívó
   * tölti ki (részvény-ág); a kripto-út változatlanul csak a változást adja.
   */
  coinChanges: { symbol: string; change24hPct: number; atrPct?: number; benchmarkChangePct?: number }[];
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
  /**
   * Melyik jogosult papír nyer, ha több is kitörésben van. Alap: `rawRank` (a legnagyobb
   * nyers változás) — pontosan a mai viselkedés. Lásd `momentum-ranking.ts`.
   */
  rankBy?: MomentumRanker;
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

  // A rangsor a KIVÁLASZTÁS (nem a jogosultság). A `-Infinity` pontszám azt jelenti,
  // hogy a jelöltet ez a rangsor nem tudja megítélni (pl. hiányzó ATR) — ilyenkor NEM
  // lépünk be vaktában, hanem a jelölt kiesik.
  const rank = params.rankBy ?? rawRank;
  const scored = eligible
    .map((c) => ({ candidate: c, score: rank(c) }))
    .filter((s) => Number.isFinite(s.score));
  if (scored.length === 0) return none("Nincs rangsorolható momentum-jelölt.");

  const best = scored.reduce((top, s) => (s.score > top.score ? s : top));
  const pick = best.candidate;
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

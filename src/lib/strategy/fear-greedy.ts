import { PROFIT_CYCLE } from "@/lib/config";

/**
 * Fear-greedy DCA halmozási logika. Tiszta függvény — nincs DB, nincs hálózat.
 * Lásd: docs/superpowers/specs/2026-06-26-profit-cycle-design.md §3.2.
 *
 * Megjegyzés a skálához: a change24hPct SZÁZALÉKPONTBAN érkezik (CoinGecko
 * usd_24h_change, pl. -3 = -3%), ezért a PROFIT_CYCLE.dcaMax24hDropPct (0.08)
 * törtet ×100-zal hasonlítjuk (-8 küszöb).
 */

export interface DcaSignal {
  shouldAccumulate: boolean;
  symbol: string | null; // a legolcsóbb/leginkább esett coin a kosárból
  amountUsd: number; // 2% tőke
  reason: string;
}

export interface DcaContext {
  fearGreedValue: number | null; // 0..100, null = nincs adat
  coinChanges: { symbol: string; change24hPct: number }[];
  weeklyBudgetRemainingUsd: number;
  totalEquity: number;
}

const noAccumulate = (reason: string): DcaSignal => ({
  shouldAccumulate: false,
  symbol: null,
  amountUsd: 0,
  reason,
});

/** Eldönti, van-e DCA-halmozási lehetőség. */
export function evaluateDca(ctx: DcaContext): DcaSignal {
  // 1) Nincs F&G adat → nem vak-vásárolunk.
  if (ctx.fearGreedValue === null) {
    return noAccumulate("Nincs Fear & Greed adat — nem halmozunk vakon.");
  }
  // 2) Nem elég olcsó a piac (F&G > küszöb).
  if (ctx.fearGreedValue > PROFIT_CYCLE.dcaFgThreshold) {
    return noAccumulate(
      `Fear & Greed ${ctx.fearGreedValue} > ${PROFIT_CYCLE.dcaFgThreshold} — a piac nem elég olcsó.`,
    );
  }
  // 3) Elfogyott a heti keret.
  if (ctx.weeklyBudgetRemainingUsd <= 0) {
    return noAccumulate("Elfogyott a heti DCA-keret.");
  }

  // 4) A kosárból: csak a -8% küszöb FELETTI coinok (nincs szabaduló zuhanás),
  //    közülük a LEGINKÁBB esett (legolcsóbb relatíve = legkisebb change24hPct).
  const maxDropPoints = PROFIT_CYCLE.dcaMax24hDropPct * 100; // 0.08 → 8 (%-pont)
  const eligible = ctx.coinChanges.filter((c) => c.change24hPct > -maxDropPoints);
  if (eligible.length === 0) {
    return noAccumulate(
      `Minden coin a -${maxDropPoints}% szabaduló-zuhanás küszöb alatt — nem veszünk.`,
    );
  }
  const pick = eligible.reduce((min, c) => (c.change24hPct < min.change24hPct ? c : min));

  return {
    shouldAccumulate: true,
    symbol: pick.symbol,
    amountUsd: ctx.totalEquity * PROFIT_CYCLE.dcaBuyPct,
    reason: `Fear & Greed ${ctx.fearGreedValue} ≤ ${PROFIT_CYCLE.dcaFgThreshold} (extrém félelem) → ${pick.symbol} halmozása (${pick.change24hPct.toFixed(1)}% 24h).`,
  };
}

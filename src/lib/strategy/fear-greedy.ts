/**
 * Fear-greedy DCA halmozási logika. Tiszta függvény — nincs DB, nincs hálózat.
 * Lásd: docs/superpowers/specs/2026-06-27-strategy-tournament-design.md §5–§6.
 *
 * Megjegyzés a skálához: a change24hPct SZÁZALÉKPONTBAN érkezik (CoinGecko
 * usd_24h_change, pl. -3 = -3%), ezért a dcaMax24hDropPct (0.08) törtet ×100-zal
 * hasonlítjuk (-8 küszöb).
 */

export interface DcaSignal {
  shouldAccumulate: boolean;
  symbol: string | null; // a legolcsóbb/leginkább esett coin a kosárból
  amountUsd: number; // dcaBuyPct * tőke
  reason: string;
}

export interface DcaContext {
  fearGreedValue: number | null; // 0..100, null = nincs adat
  coinChanges: { symbol: string; change24hPct: number }[];
  weeklyBudgetRemainingUsd: number;
  totalEquity: number;
  /** Belépő-szűrőhöz: symbol → close ≥ SMA(N). entryFilter="trend" módban a false coinok kiesnek. */
  trendOkBySymbol?: Record<string, boolean>;
}

export interface DcaParams {
  dcaFgThreshold: number;
  dcaMax24hDropPct: number;
  dcaBuyPct: number;
  entryFilter: "off" | "trend";
}

const noAccumulate = (reason: string): DcaSignal => ({
  shouldAccumulate: false,
  symbol: null,
  amountUsd: 0,
  reason,
});

/** Eldönti, van-e DCA-halmozási lehetőség. */
export function evaluateDca(ctx: DcaContext, params: DcaParams): DcaSignal {
  // 1) Nincs F&G adat → nem vak-vásárolunk.
  if (ctx.fearGreedValue === null) {
    return noAccumulate("Nincs Fear & Greed adat — nem halmozunk vakon.");
  }
  // 2) Nem elég olcsó a piac (F&G > küszöb).
  if (ctx.fearGreedValue > params.dcaFgThreshold) {
    return noAccumulate(
      `Fear & Greed ${ctx.fearGreedValue} > ${params.dcaFgThreshold} — a piac nem elég olcsó.`,
    );
  }
  // 3) Elfogyott a heti keret.
  if (ctx.weeklyBudgetRemainingUsd <= 0) {
    return noAccumulate("Elfogyott a heti DCA-keret.");
  }

  // 4) Jogosult coinok: a -dcaMax24hDropPct küszöb FELETTIEK (nincs szabaduló zuhanás),
  //    és trend módban a lefelé trendben lévők (trendOk=false) kiesnek.
  const maxDropPoints = params.dcaMax24hDropPct * 100; // 0.08 → 8 (%-pont)
  let eligible = ctx.coinChanges.filter((c) => c.change24hPct > -maxDropPoints);
  if (params.entryFilter === "trend") {
    eligible = eligible.filter((c) => ctx.trendOkBySymbol?.[c.symbol] !== false);
  }
  if (eligible.length === 0) {
    return noAccumulate("Nincs jogosult coin (zuhanás-küszöb / trend-szűrő).");
  }

  const pick = eligible.reduce((min, c) => (c.change24hPct < min.change24hPct ? c : min));

  return {
    shouldAccumulate: true,
    symbol: pick.symbol,
    amountUsd: ctx.totalEquity * params.dcaBuyPct,
    reason: `Fear & Greed ${ctx.fearGreedValue} ≤ ${params.dcaFgThreshold} (extrém félelem) → ${pick.symbol} halmozása (${pick.change24hPct.toFixed(1)}% 24h).`,
  };
}

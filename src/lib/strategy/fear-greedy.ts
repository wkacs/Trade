/**
 * Fear-greedy DCA halmozási logika. Tiszta függvény — nincs DB, nincs hálózat.
 * A vétel mérete a sizeEntry-n megy (kockázat-alapú, ha bekapcsolt; egyébként flat).
 * Lásd: docs/superpowers/specs/2026-06-27-strategy-tournament-design.md §5–§6.
 *
 * Megjegyzés a skálához: a change24hPct SZÁZALÉKPONTBAN érkezik (CoinGecko
 * usd_24h_change, pl. -3 = -3%), ezért a dcaMax24hDropPct (0.08) törtet ×100-zal
 * hasonlítjuk (-8 küszöb).
 */

import { sizeEntry } from "@/lib/strategy/sizing";

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
  /**
   * Minimum kötésérték USD-ben. A maradék keretre vágott vétel ez alatt NEM tervezhető
   * (a tőzsdei minimum notional alatti order amúgy is elutasításra kerülne). Alap: 1.
   */
  minOrderUsd?: number;
  // Opcionális kockázat-alapú méretezés (hiányzó → flat dcaBuyPct, identikus a régivel).
  riskPerTradePct?: number;
  stopLossPct?: number;
  stopMode?: "fixed" | "atr";
  maxPositionPct?: number;
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

  // A KERETRE VÁGÁS: az audit §4 szerint a régi kód csak azt nézte, POZITÍV-e a maradék,
  // ezért 1 USD maradék mellett is 2 USD vételt tervezett. A terv soha nem lépheti túl a
  // maradékot, és a minimum kötésérték alatt nincs kötés.
  const desired = sizeEntry(ctx.totalEquity, {
    riskPerTradePct: params.riskPerTradePct ?? 0,
    stopLossPct: params.stopLossPct ?? 0.05,
    stopMode: params.stopMode ?? "fixed",
    maxPositionPct: params.maxPositionPct ?? 0.2,
    flatPct: params.dcaBuyPct,
  });
  const amountUsd = Math.min(desired, ctx.weeklyBudgetRemainingUsd);
  const minOrderUsd = params.minOrderUsd ?? 1;
  if (amountUsd < minOrderUsd) {
    return noAccumulate(
      `A heti keret maradéka (${ctx.weeklyBudgetRemainingUsd.toFixed(2)} USD) a minimum ${minOrderUsd} USD kötésérték alatt van.`,
    );
  }

  return {
    shouldAccumulate: true,
    symbol: pick.symbol,
    amountUsd,
    reason:
      `Fear & Greed ${ctx.fearGreedValue} ≤ ${params.dcaFgThreshold} (extrém félelem) → ${pick.symbol} halmozása ` +
      `(${pick.change24hPct.toFixed(1)}% 24h)` +
      (amountUsd < desired ? `, a heti keret maradékára vágva (${amountUsd.toFixed(2)} USD).` : "."),
  };
}

/**
 * Backtest CLI: a teljes Binance-historyn futtatja a kód-profit-ciklust, és kiír egy
 * metrika-riportot. Futtatás: pnpm tsx scripts/backtest.ts [--pages N] [--slippage BPS]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  const { loadHistory } = await import("@/lib/backtest/data");
  const { runBacktest } = await import("@/lib/backtest/engine");
  const { COIN_UNIVERSE } = await import("@/lib/config");

  const arg = (name: string, def: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : def;
  };
  const pages = arg("pages", 5);
  const slippageBps = arg("slippage", 5);

  console.log(`Backtest: ${COIN_UNIVERSE.join(",")} | ${pages} klines-lap | slippage ${slippageBps}bps`);
  const { frames: history, quality } = await loadHistory([...COIN_UNIVERSE], pages);
  console.log(`Betöltve: ${history.length} órás keret`);
  if (quality.degraded) {
    console.warn("⚠ Az adatsor HIÁNYOS vagy réses — a metrikák ezzel a korláttal értendők:");
    for (const [sym, q] of Object.entries(quality.bySymbol)) {
      console.warn(`   ${sym}: ${q.bars} gyertya, ${q.gaps} rés, kiesett lezáratlan ${q.droppedUnclosed}, duplikátum ${q.droppedDuplicate}${q.error ? `, hiba: ${q.error}` : ""}`);
    }
  }

  const result = runBacktest(history, {
    symbols: [...COIN_UNIVERSE],
    initialCapitalUsd: 10000,
    feePct: 0.001,
    slippageBps,
  });

  const m = result.metrics;
  console.log("\n=== METRIKÁK ===");
  console.log(`Total return : ${(m.totalReturnPct * 100).toFixed(2)}%`);
  console.log(`Sharpe       : ${m.sharpe.toFixed(2)}`);
  console.log(`Max drawdown : ${(m.maxDrawdownPct * 100).toFixed(2)}%`);
  console.log(`Hit rate     : ${(m.hitRate * 100).toFixed(1)}%  (${m.tradesCount} lezárt trade)`);
  console.log(`Avg win/loss : +${(m.avgWinPct * 100).toFixed(2)}% / ${(m.avgLossPct * 100).toFixed(2)}%`);
  console.log(`Profit factor: ${m.profitFactor.toFixed(2)}`);
  console.log(`Exposure     : ${(m.exposurePct * 100).toFixed(1)}%`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Egyenként backteszteli a jelölt coinokat a DEFAULT_STRATEGY-vel (walk-forward), és
 * kiír egy rangsort. Kapu: pozitív OOS hozam ÉS OOS Sharpe ≥ küszöb. Report-only — a
 * nyertes listát KÉZZEL veszed át a COIN_UNIVERSE-be. Futtatás:
 *   npx tsx scripts/coin-screen.ts --pages 8 --min-sharpe 1.0
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  const { loadHistory } = await import("@/lib/backtest/data");
  const { runBacktest } = await import("@/lib/backtest/engine");
  const { splitHistory } = await import("@/lib/backtest/walk-forward");
  const { DEFAULT_STRATEGY } = await import("@/lib/strategy/config");

  const arg = (n: string, d: number) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? Number(process.argv[i + 1]) : d;
  };
  const pages = arg("pages", 8);
  const minSharpe = arg("min-sharpe", 1.0);
  const candidates = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "AVAX", "LINK", "DOGE", "LTC", "DOT", "MATIC"];

  console.log(`Coin-screen: ${candidates.length} jelölt | ${pages} lap | OOS-kapu Sharpe ≥ ${minSharpe}\n`);
  const rows: { sym: string; oosRet: number; oosSharpe: number; pass: boolean }[] = [];
  for (const sym of candidates) {
    try {
      const { frames: history } = await loadHistory([sym], pages);
      if (history.length < 100) {
        console.log(`  ${sym}: nincs elég adat`);
        continue;
      }
      const { outSample } = splitHistory(history, 0.7);
      const r = runBacktest(
        outSample,
        { symbols: [sym], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 },
        DEFAULT_STRATEGY,
      );
      const oosRet = r.metrics.totalReturnPct;
      const oosSharpe = r.metrics.sharpe;
      const pass = oosRet > 0 && oosSharpe >= minSharpe;
      rows.push({ sym, oosRet, oosSharpe, pass });
    } catch (e) {
      console.log(`  ${sym}: hiba (${String(e).slice(0, 60)})`);
    }
  }
  rows.sort((a, b) => b.oosSharpe - a.oosSharpe);
  for (const r of rows) {
    console.log(
      `  ${r.pass ? "✅" : "❌"} ${r.sym.padEnd(5)} | OOS ret ${(r.oosRet * 100).toFixed(2).padStart(6)}% | Sharpe ${r.oosSharpe.toFixed(2).padStart(5)}`,
    );
  }
  const winners = rows.filter((r) => r.pass).map((r) => r.sym);
  console.log(`\nKurált univerzum (kapun túl): [${winners.map((s) => `"${s}"`).join(", ")}]`);
  console.log(`→ KÉZZEL vedd át a src/lib/config.ts COIN_UNIVERSE-be, ha a Task 8 teljes-univerzum backteszt is javul.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

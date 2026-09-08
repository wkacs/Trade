/**
 * Részvény-tick demo CLI — READ-ONLY, memóriában (nincs DB, nincs live). Megmutatja a
 * teljes részvény-motort: cadence (napi, after-hours) → Stooq napi gyertyák → profit-ciklus
 * (stop/TP/trailing/DCA) végrehajtása egy szimulált USD-portfólión.
 *
 * Futtatás:  MARKETS_ENABLE_STOCKS=1 pnpm tsx scripts/stock-tick-demo.ts [--capital 10000]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  const { activeByClass } = await import("@/lib/markets/registry");
  const { fetchInstrumentCandles } = await import("@/lib/markets/data");
  const { emptyLedger } = await import("@/lib/portfolio/ledger");
  const {
    runStockCycle,
    stockDecisionDue,
    STOCK_QUOTE,
    STOCK_PORTFOLIO_ID,
  } = await import("@/lib/engine/stock-tick");

  const argN = (name: string, def: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : def;
  };
  const capital = argN("capital", 10000);
  const now = Date.now();

  const gate = stockDecisionDue(now, null);
  console.log(`Cadence: due=${gate.due} (${gate.reason})` + (gate.decisionDate ? ` nap=${gate.decisionDate}` : ""));
  console.log("(A napi részvény-döntés az ülés ZÁRÁSA után esedékes; ez a demó mindenképp lefuttatja a ciklust.)\n");

  const instruments = activeByClass("stock");
  if (instruments.length === 0) {
    console.log("Nincs aktív részvény. Kapcsold be: MARKETS_ENABLE_STOCKS=1");
    return;
  }

  const candlesBySymbol: Record<string, Awaited<ReturnType<typeof fetchInstrumentCandles>>["candles"]> = {};
  for (const inst of instruments) {
    const { candles, error } = await fetchInstrumentCandles(inst, 60, { now: () => now });
    if (error) {
      console.log(`  ${inst.symbol}: adat-hiba [${error.code}] ${error.message}`);
      continue;
    }
    candlesBySymbol[inst.symbol] = candles;
    const last = candles[candles.length - 1];
    console.log(`  ${inst.symbol.padEnd(6)} ${candles.length} napi gyertya` + (last ? `, utolsó close ${last.close} USD` : ""));
  }

  const ledger = emptyLedger(STOCK_PORTFOLIO_ID, "paper", String(capital), STOCK_QUOTE);
  const res = await runStockCycle({
    tickId: new Date(now).toISOString().slice(0, 10),
    now: () => now,
    ledger,
    instruments,
    candlesBySymbol,
    weeklyBudgetRemainingUsd: capital * 0.05,
  });

  console.log(`\nVégrehajtott akciók: ${res.actions.length}`);
  for (const a of res.actions) {
    console.log(`  ${a.kind.padEnd(11)} ${a.side} ${a.symbol} qty=${a.qty} (${a.amountUsd} USD)`);
  }
  console.log(`\nZáró USD cash: ${res.ledger.cash[STOCK_QUOTE]}`);
  const posSyms = Object.values(res.ledger.positions).filter((p) => Number(p.qty) > 0).map((p) => p.symbol);
  console.log(`Nyitott pozíciók: ${posSyms.length > 0 ? posSyms.join(", ") : "nincs"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

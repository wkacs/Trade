/**
 * Multi-asset demo CLI — READ-ONLY. A live tick-et NEM érinti; csak megmutatja, hogy az
 * új `markets/` réteg végigmegy: aktív univerzum → kereskedhetőség (naptár) → gyertyák
 * (Binance/Stooq) → egy szimulált paper fill a legutolsó záróárból.
 *
 * Futtatás:
 *   MARKETS_ENABLE_STOCKS=1 pnpm tsx scripts/markets-demo.ts [--bars N]
 *   MARKETS_EXTRA_CRYPTO=BNB,XRP pnpm tsx scripts/markets-demo.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  const { activeInstruments } = await import("@/lib/markets/registry");
  const { tradabilitySnapshot } = await import("@/lib/markets/tradability");
  const { fetchInstrumentCandles } = await import("@/lib/markets/data");
  const { fillParamsForInstrument } = await import("@/lib/markets/execution");
  const { simulatePaperFill } = await import("@/lib/execution/paper-fill");

  const argN = (name: string, def: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : def;
  };
  const bars = argN("bars", 30);
  const now = Date.now();

  const instruments = activeInstruments();
  console.log(`Aktív instrumentumok (${instruments.length}): ${instruments.map((i) => i.symbol).join(", ")}`);
  console.log(`(MARKETS_ENABLE_STOCKS=${process.env.MARKETS_ENABLE_STOCKS ?? "-"}, ` +
    `MARKETS_EXTRA_CRYPTO=${process.env.MARKETS_EXTRA_CRYPTO ?? "-"})\n`);

  const trad = tradabilitySnapshot(now);
  for (const t of trad) {
    console.log(`  ${t.instrument.symbol.padEnd(6)} ${t.instrument.assetClass.padEnd(7)} ` +
      `${t.tradable ? "KERESKEDHETŐ" : "zárva     "}  (${t.session.reason})`);
  }
  console.log();

  for (const inst of instruments) {
    const { candles, error, timeframe } = await fetchInstrumentCandles(inst, bars, { now: () => now });
    if (error) {
      console.log(`  ${inst.symbol}: adat-hiba [${error.code}] ${error.message}`);
      continue;
    }
    if (candles.length === 0) {
      console.log(`  ${inst.symbol}: nincs lezárt gyertya`);
      continue;
    }
    const last = candles[candles.length - 1];
    const params = fillParamsForInstrument(inst, now);
    const fill = simulatePaperFill(
      { side: "BUY", kind: "market", symbol: inst.symbol, maxQuoteSpend: "1000", market: { last: String(last.close) } },
      params,
    );
    const fillStr = fill.ok
      ? `fill: ${fill.filledBaseQty} @ ${fill.fillPrice} (${fill.grossQuoteAmount} ${fill.feeAsset})`
      : `fill elutasítva: ${fill.reason}`;
    console.log(`  ${inst.symbol.padEnd(6)} ${timeframe}  ${candles.length} gyertya  ` +
      `utolsó close ${last.close} ${inst.quote}  → 1000-ból ${fillStr}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

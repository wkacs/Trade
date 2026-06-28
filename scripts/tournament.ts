/**
 * Variáns-tournament: gridet sweepel walk-forward módon, OOS Sharpe szerint rangsorol.
 * Futtatás: pnpm tsx scripts/tournament.ts [--pages N] [--min-trades M] [--top K]
 * Report-only: nincs DB-írás, nincs auto-apply — a nyerő configot kézzel veszed át a
 * DEFAULT_STRATEGY-be. Lásd tournament spec §9.
 */
import { config as dotenv } from "dotenv";
import type { StrategyConfig } from "@/lib/strategy/config";
import type { BacktestResult } from "@/lib/backtest/types";

dotenv({ path: ".env.local" });
dotenv();

async function main() {
  const { loadHistory } = await import("@/lib/backtest/data");
  const { runBacktest } = await import("@/lib/backtest/engine");
  const { splitHistory, rankConfigs } = await import("@/lib/backtest/walk-forward");
  const { DEFAULT_STRATEGY } = await import("@/lib/strategy/config");
  const { COIN_UNIVERSE } = await import("@/lib/config");

  const arg = (n: string, d: number) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? Number(process.argv[i + 1]) : d;
  };
  const pages = arg("pages", 5);
  const minTrades = arg("min-trades", 15);
  const top = arg("top", 15);
  const robust = process.argv.includes("--robust");

  // Grid (spec §7).
  const grid: StrategyConfig[] = [];
  const tps = [0.1, 0.15, 0.25, 0.4];
  const tpFracs = [0.5, 1.0];
  const fgs = [20, 25, 35];
  const dcaBuys = [0.02, 0.04];
  const weeklies = [0.05, 0.1, 0.2];
  const filters: { entryFilter: "off" | "trend"; entryFilterSmaPeriod: number }[] = [
    { entryFilter: "off", entryFilterSmaPeriod: 24 },
    { entryFilter: "trend", entryFilterSmaPeriod: 24 },
    { entryFilter: "trend", entryFilterSmaPeriod: 72 },
  ];
  const stops: Partial<StrategyConfig>[] = [
    { stopMode: "fixed", stopLossPct: 0.04 },
    { stopMode: "fixed", stopLossPct: 0.05 },
    { stopMode: "fixed", stopLossPct: 0.07 },
    { stopMode: "fixed", stopLossPct: 0.1 },
    { stopMode: "atr", atrMult: 1.5 },
    { stopMode: "atr", atrMult: 2 },
    { stopMode: "atr", atrMult: 3 },
  ];
  for (const s of stops)
    for (const tp of tps)
      for (const tf of tpFracs)
        for (const fg of fgs)
          for (const db of dcaBuys)
            for (const wk of weeklies)
              for (const f of filters)
                grid.push({
                  ...DEFAULT_STRATEGY,
                  ...s,
                  takeProfitPct: tp,
                  takeProfitFraction: tf,
                  dcaFgThreshold: fg,
                  dcaBuyPct: db,
                  dcaWeeklyBudgetPct: wk,
                  ...f,
                });

  console.log(`Tournament: ${grid.length} config | ${pages} klines-lap | min OOS trade ${minTrades}`);
  const history = await loadHistory([...COIN_UNIVERSE], pages);
  const { inSample, outSample } = splitHistory(history, 0.7);
  console.log(`Betöltve: ${history.length} óra (IS ${inSample.length} / OOS ${outSample.length})`);
  const btCfg = { symbols: [...COIN_UNIVERSE], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 };

  const items = grid.map((cfg) => ({
    config: cfg,
    is: runBacktest(inSample, btCfg, cfg),
    oos: runBacktest(outSample, btCfg, cfg),
  }));

  const base = {
    config: DEFAULT_STRATEGY,
    is: runBacktest(inSample, btCfg, DEFAULT_STRATEGY),
    oos: runBacktest(outSample, btCfg, DEFAULT_STRATEGY),
  };
  const fmt = (r: BacktestResult) =>
    `ret ${(r.metrics.totalReturnPct * 100).toFixed(1)}% · Sharpe ${r.metrics.sharpe.toFixed(2)} · PF ${r.metrics.profitFactor.toFixed(2)} · maxDD ${(r.metrics.maxDrawdownPct * 100).toFixed(1)}% · ${r.metrics.tradesCount} trade`;
  const desc = (c: StrategyConfig) =>
    `stop ${c.stopMode === "atr" ? `atr×${c.atrMult}` : `fix${(c.stopLossPct * 100).toFixed(0)}%`} · TP ${(c.takeProfitPct * 100).toFixed(0)}%/${c.takeProfitFraction} · FG${c.dcaFgThreshold} · dca ${(c.dcaBuyPct * 100).toFixed(0)}%/${(c.dcaWeeklyBudgetPct * 100).toFixed(0)}% · ${c.entryFilter}${c.entryFilter === "trend" ? c.entryFilterSmaPeriod : ""}`;

  console.log(`\n=== BASELINE (mai default) ===\n  IS:  ${fmt(base.is)}\n  OOS: ${fmt(base.oos)}`);

  const ranked = rankConfigs(items, minTrades, { robust });
  console.log(
    `\n=== TOP ${top} (${robust ? "ROBUST: IS>0 ÉS OOS>0, min(IS,OOS) Sharpe" : "OOS Sharpe"}; ${ranked.length}/${grid.length} config a kapun túl) ===`,
  );
  if (ranked.length === 0) {
    console.log("  Egyetlen config sem érte el a min-trade kaput az OOS-on (próbálj több --pages-t vagy kisebb --min-trades-et).");
    return;
  }
  ranked.slice(0, top).forEach((r, i) => {
    console.log(`  #${i + 1} ${desc(r.config)}`);
    console.log(`      IS:  ${fmt(r.is)}\n      OOS: ${fmt(r.oos)}`);
  });

  const beats = ranked[0].oos.metrics.sharpe > base.oos.metrics.sharpe;
  console.log(
    `\n${beats ? "✅ A #1 config OOS-on VERI a defaultot — érdemes átvenni a DEFAULT_STRATEGY-be." : "ℹ️ Egyetlen config sem veri a default OOS Sharpe-ját — maradj a defaultnál."}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

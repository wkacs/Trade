/**
 * Variáns-tournament ZÁROLT végső teszttel (T19).
 *
 * Futtatás: pnpm tsx scripts/tournament.ts [--pages N] [--min-trades M] [--top K]
 *                                          [--holdout 0.2] [--train 720] [--validation 240]
 *
 * FONTOS VÁLTOZÁS az auditot (§7) követően: a régi verzió a TESZTSZAKASZ eredményét is
 * használta a rangsorhoz, ezzel a szakasz validációs adattá vált, nem független végső
 * teszt maradt. Itt a történet vége ZÁROLT holdout:
 *
 *   1. A jelöltválasztás KIZÁRÓLAG a fejlesztési részből, időben gördülő
 *      tanítás/validálás szeleteken történik.
 *   2. A holdouton EGYSZER mérünk, a MÁR kiválasztott jelölttel.
 *   3. A holdout eredménye NEM változtathat a kiválasztáson — ha nem tetszik,
 *      az önmagában NEM ok új jelölt keresésére ugyanezen az adaton.
 *
 * Report-only: nincs DB-írás, nincs auto-apply. A nyerő config átvétele kézi döntés.
 */
import { config as dotenv } from "dotenv";
import type { StrategyConfig } from "@/lib/strategy/config";
import type { BacktestResult } from "@/lib/backtest/types";

dotenv({ path: ".env.local" });
dotenv();

async function main() {
  const { loadHistory } = await import("@/lib/backtest/data");
  const { runBacktest } = await import("@/lib/backtest/engine");
  const { lockHoldout, rollingSplits, selectCandidate, evaluateOnHoldout, buildProvenance } = await import(
    "@/lib/backtest/walk-forward"
  );
  const { benchmarkSuite } = await import("@/lib/backtest/benchmarks");
  const { DEFAULT_STRATEGY, STRATEGY_VERSION } = await import("@/lib/strategy/config");
  const { COIN_UNIVERSE } = await import("@/lib/config");
  const { strategyRequiredBars } = await import("@/lib/engine/profit-cycle");

  const arg = (n: string, d: number) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? Number(process.argv[i + 1]) : d;
  };
  const pages = arg("pages", 5);
  const minTrades = arg("min-trades", 15);
  const top = arg("top", 15);
  const holdoutRatio = arg("holdout", 0.2);
  const trainBars = arg("train", 720); // 30 nap
  const validationBars = arg("validation", 240); // 10 nap

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

  console.log(`Tournament: ${grid.length} config | ${pages} klines-lap | min trade/szelet ${minTrades}`);
  const { frames: history, quality } = await loadHistory([...COIN_UNIVERSE], pages);
  const btCfg = { symbols: [...COIN_UNIVERSE], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 };

  const split = lockHoldout(history, holdoutRatio);
  const provenance = buildProvenance(split, btCfg, STRATEGY_VERSION);
  console.log(
    `Betöltve: ${history.length} óra → fejlesztés ${split.development.length} / ZÁROLT holdout ${split.holdout.length}`,
  );
  console.log(
    `Adat-hash: fejlesztés ${provenance.developmentDataHash}, holdout ${provenance.holdoutDataHash} | stratégia ${provenance.strategyVersion}`,
  );
  console.log(
    `Költségfeltevés: díj ${(btCfg.feePct * 100).toFixed(2)}%, csúszás ${btCfg.slippageBps} bps, tőke ${btCfg.initialCapitalUsd} USD, mód ${provenance.executionModel}`,
  );
  if (quality.degraded) {
    console.warn("⚠ HIÁNYOS vagy réses adatsor — a rangsor ezzel a korláttal értendő.");
  }

  // A warmup a MÚLTBÓL jön: minden validációs szelet elé a stratégia visszatekintése.
  const warmupBars = strategyRequiredBars(DEFAULT_STRATEGY);
  const splits = rollingSplits(split.development, { trainBars, validationBars, warmupBars });
  if (splits.length === 0) {
    console.error(
      `Nincs elég adat a gördülő szeletekhez (train ${trainBars} + validation ${validationBars} > ${split.development.length}).`,
    );
    return;
  }
  console.log(`Gördülő szeletek: ${splits.length} (train ${trainBars} / validation ${validationBars} + ${warmupBars} warmup)`);

  const fmt = (r: BacktestResult) =>
    `ret ${(r.metrics.totalReturnPct * 100).toFixed(1)}% · Sharpe ${r.metrics.sharpe.toFixed(2)} · PF ${
      r.metrics.profitFactorInfinite ? "inf" : r.metrics.profitFactor === null ? "n/a" : r.metrics.profitFactor.toFixed(2)
    } · maxDD ${(r.metrics.maxDrawdownPct * 100).toFixed(1)}% · ${r.metrics.tradesCount} realizálás`;
  const desc = (c: StrategyConfig) =>
    `stop ${c.stopMode === "atr" ? `atr×${c.atrMult}` : `fix${(c.stopLossPct * 100).toFixed(0)}%`} · TP ${(
      c.takeProfitPct * 100
    ).toFixed(0)}%/${c.takeProfitFraction} · FG${c.dcaFgThreshold} · dca ${(c.dcaBuyPct * 100).toFixed(0)}%/${(
      c.dcaWeeklyBudgetPct * 100
    ).toFixed(0)}% · ${c.entryFilter}${c.entryFilter === "trend" ? c.entryFilterSmaPeriod : ""}`;

  // ── 1) Jelöltválasztás — CSAK a fejlesztési részből. ───────────────────────
  const selection = selectCandidate(
    grid,
    splits,
    (cfg, s) => runBacktest(s.validation, btCfg, cfg),
    { minTradesPerSplit: minTrades, developmentDataHash: provenance.developmentDataHash },
  );

  console.log(`\n=== TOP ${top} a VALIDÁCIÓN (a leggyengébb szelet Sharpe-ja szerint) ===`);
  selection.ranked.slice(0, top).forEach((c, i) => {
    console.log(
      `  #${i + 1} ${desc(c.config)}\n      leggyengébb szelet ${c.robustScore.toFixed(2)} · átlag ${c.meanValidationSharpe.toFixed(
        2,
      )} · ${c.totalTrades} realizálás`,
    );
  });

  if (!selection.winner) {
    console.log("\nEgyetlen jelölt sem érte el a min-trade kaput a szeleteken. NEM ELDÖNTHETŐ — nincs győztes.");
    return;
  }

  // ── 2) EGYSZERI mérés a ZÁROLT holdouton. Innen már nem rangsorolunk. ─────
  const holdoutReport = evaluateOnHoldout(selection.winner.config, split.holdout, (cfg, frames) =>
    runBacktest(frames, btCfg, cfg),
  );
  const baselineHoldout = runBacktest(split.holdout, btCfg, DEFAULT_STRATEGY);

  console.log(`\n=== ZÁROLT HOLDOUT (egyszeri mérés, ${holdoutReport.bars} keret) ===`);
  console.log(`  Kiválasztott: ${desc(selection.winner.config)}`);
  console.log(`  Holdout:  ret ${(holdoutReport.metrics.totalReturnPct * 100).toFixed(1)}% · Sharpe ${holdoutReport.metrics.sharpe.toFixed(2)} · ${holdoutReport.metrics.tradesCount} realizálás`);
  console.log(`  Baseline: ${fmt(baselineHoldout)}`);

  // ── 3) Alapvonalak: cash és buy-and-hold ugyanazon az időszakon. ──────────
  console.log("\n=== ALAPVONALAK a holdouton (100 és 10 000 USD, alap és kétszeres költség) ===");
  const suite = benchmarkSuite(split.holdout, btCfg, {
    capitals: [100, 10000],
    costMultipliers: [1, 2],
    strategies: [
      { name: "dca-baseline", config: DEFAULT_STRATEGY },
      { name: "kivalasztott", config: selection.winner.config },
    ],
  });
  for (const e of suite) {
    console.log(
      `  ${String(e.capitalUsd).padStart(5)} USD ×${e.costMultiplier} ${e.name.padEnd(20)} ret ${(
        e.metrics.totalReturnPct * 100
      ).toFixed(1)}% · Sharpe ${e.metrics.sharpe.toFixed(2)} · ${e.metrics.tradesCount} realizálás`,
    );
    for (const n of e.notes) console.log(`        ↳ ${n}`);
  }

  console.log(
    "\nA holdout eredménye NEM ok új jelölt keresésére ugyanezen az adaton. Ha a kiválasztott " +
      "változat itt nem teljesít, az érvényes eredmény: a javított alapvonal marad.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

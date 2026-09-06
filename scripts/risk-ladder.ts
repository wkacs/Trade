/**
 * Kockázat-létra (2026-09-06) — mennyit hoz és mennyit kockáztat több kitettség?
 *
 * NEM tournament: itt nincs ezres nagyságrendű rács és nincs nyertes-válogatás. Hat,
 * ELŐRE megnevezett lépcső fut, a konzervatívtól az agresszívig, hogy a hozam/kockázat
 * átváltás LÁTHATÓ legyen. A cél nem a legjobb szám megtalálása, hanem annak megmutatása,
 * mit vásárolsz a nagyobb kockázattal — és mit fizetsz érte.
 *
 * Futtatás: pnpm tsx scripts/risk-ladder.ts [--pages N] [--capital USD]
 */
import { config as dotenv } from "dotenv";
import type { StrategyConfig } from "@/lib/strategy/config";

dotenv({ path: ".env.local" });
dotenv();

async function main() {
  const { loadHistory } = await import("@/lib/backtest/data");
  const { runBacktest } = await import("@/lib/backtest/engine");
  const { lockHoldout } = await import("@/lib/backtest/walk-forward");
  const { benchmarkSuite } = await import("@/lib/backtest/benchmarks");
  const { DEFAULT_STRATEGY } = await import("@/lib/strategy/config");
  const { COIN_UNIVERSE } = await import("@/lib/config");

  const arg = (n: string, d: number) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? Number(process.argv[i + 1]) : d;
  };
  const pages = arg("pages", 10);
  const capital = arg("capital", 320);

  const ladder: { id: string; note: string; strategy: StrategyConfig }[] = [
    {
      id: "L0 mai élő",
      note: "változatlan alapvonal",
      strategy: { ...DEFAULT_STRATEGY },
    },
    {
      id: "L1 lazább kapu",
      note: "FG35, nagyobb DCA-méret és heti keret",
      strategy: { ...DEFAULT_STRATEGY, dcaFgThreshold: 35, dcaBuyPct: 0.04, dcaWeeklyBudgetPct: 0.2 },
    },
    {
      id: "L2 + nagyobb pozíció",
      note: "max pozíció 35%, a nyertest hagyjuk futni (TP 25% teljes)",
      strategy: {
        ...DEFAULT_STRATEGY,
        dcaFgThreshold: 35,
        dcaBuyPct: 0.04,
        dcaWeeklyBudgetPct: 0.2,
        maxPositionPct: 0.35,
        takeProfitPct: 0.25,
        takeProfitFraction: 1,
      },
    },
    {
      id: "L3 + momentum",
      note: "trendkövető belépő is, tágabb stop (7%)",
      strategy: {
        ...DEFAULT_STRATEGY,
        dcaFgThreshold: 35,
        dcaBuyPct: 0.04,
        dcaWeeklyBudgetPct: 0.2,
        maxPositionPct: 0.35,
        takeProfitPct: 0.25,
        takeProfitFraction: 1,
        momentumEnabled: true,
        stopLossPct: 0.07,
      },
    },
    {
      id: "L4 agresszív",
      note: "max pozíció 50%, DCA 10%/heti 50%, napi kapu 6%",
      strategy: {
        ...DEFAULT_STRATEGY,
        dcaFgThreshold: 35,
        dcaBuyPct: 0.1,
        dcaWeeklyBudgetPct: 0.5,
        maxPositionPct: 0.5,
        takeProfitPct: 0.25,
        takeProfitFraction: 1,
        momentumEnabled: true,
        stopLossPct: 0.07,
        dailyLossCircuitBreakerPct: 0.06,
      },
    },
    {
      id: "L5 trend all-in",
      note: "szűrő KI, TP 40%, stop 10% — maximális kitettség",
      strategy: {
        ...DEFAULT_STRATEGY,
        dcaFgThreshold: 50,
        dcaBuyPct: 0.1,
        dcaWeeklyBudgetPct: 0.5,
        maxPositionPct: 0.5,
        takeProfitPct: 0.4,
        takeProfitFraction: 1,
        momentumEnabled: true,
        entryFilter: "off",
        stopLossPct: 0.1,
        dailyLossCircuitBreakerPct: 0.06,
      },
    },
  ];

  const { frames, quality } = await loadHistory([...COIN_UNIVERSE], pages);
  const split = lockHoldout(frames, 0.2);
  const btCfg = { symbols: [...COIN_UNIVERSE], initialCapitalUsd: capital, feePct: 0.001, slippageBps: 5 };

  console.log(`Kockázat-létra | ${frames.length} óra | tőke ${capital} USD | díj 0.10% + 5 bps`);
  console.log(`Fejlesztési szakasz ${split.development.length} óra · holdout ${split.holdout.length} óra`);
  if (quality.degraded) console.warn("⚠ Az adatsor hiányos — a számok ezzel a korláttal értendők.");

  const row = (id: string, note: string, frames_: typeof frames, s: StrategyConfig) => {
    const r = runBacktest(frames_, btCfg, s);
    const m = r.metrics;
    return (
      `${id.padEnd(20)} hozam ${(m.totalReturnPct * 100).toFixed(2).padStart(7)}% · ` +
      `Sharpe ${m.sharpe.toFixed(2).padStart(5)} · maxDD ${(m.maxDrawdownPct * 100).toFixed(2).padStart(5)}% · ` +
      `kötés ${String(m.tradesCount).padStart(4)} · díj ${m.totalFeesUsd.toFixed(2).padStart(7)} USD   (${note})`
    );
  };

  for (const [label, frames_] of [
    ["FEJLESZTÉSI SZAKASZ", split.development],
    ["ZÁROLT HOLDOUT", split.holdout],
  ] as const) {
    console.log(`\n=== ${label} ===`);
    for (const step of ladder) console.log(row(step.id, step.note, frames_, step.strategy));
    // Kontrollok UGYANAZON a tőkén és alapköltségen — enélkül a lépcső számai lebegnek.
    const bench = benchmarkSuite(frames_, btCfg, { capitals: [capital], costMultipliers: [1] });
    for (const b of bench) {
      if (!b.name.startsWith("buy-and-hold") && b.name !== "cash") continue;
      const m = b.metrics;
      console.log(
        `${b.name.padEnd(20)} hozam ${(m.totalReturnPct * 100).toFixed(2).padStart(7)}% · ` +
          `Sharpe ${m.sharpe.toFixed(2).padStart(5)} · maxDD ${(m.maxDrawdownPct * 100).toFixed(2).padStart(5)}%   (kontroll)`,
      );
    }
  }

  console.log(
    "\nA magasabb lépcső NEM ajánlás: a nagyobb hozam nagyobb visszaeséssel és több díjjal jár.\n" +
      "A holdout egyszeri mérés; a lépcső kiválasztása utólag, ezen az adaton, túlillesztés lenne.",
  );
}

main().catch((e) => {
  console.error("❌", e?.message ?? e);
  process.exit(1);
});

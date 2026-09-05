/**
 * Reprodukálható összehasonlító mérés (T30).
 *
 * A `scripts/experiment-configs.ts`-ben BEFAGYASZTOTT protokollt futtatja le, és
 * markdown jelentést ír, ami a `docs/experiments/results-v1.md`-be másolható.
 *
 * Futtatás:
 *   pnpm tsx scripts/compare-strategies.ts                 # teljes mérés, jelentés a stdoutra
 *   pnpm tsx scripts/compare-strategies.ts --out docs/experiments/results-v1.md
 *   pnpm tsx scripts/compare-strategies.ts --pages 9       # ~365 nap (1000 gyertya/lap)
 *   pnpm tsx scripts/compare-strategies.ts --holdout       # a NYERTES EGYSZERI holdout-mérése
 *
 * AMIT EZ A SCRIPT NEM CSINÁL:
 *   - nem vált stratégiát és nem ír konfigot: kizárólag mér és jelent;
 *   - nem rangsorol a holdouton (a `--holdout` csak a fejlesztési részen kiválasztott
 *     nyertest méri, egyszer);
 *   - nem hallgat el gyenge variánst: minden változat bekerül a jelentésbe.
 */
import { config as dotenv } from "dotenv";

dotenv({ path: ".env.local" });
dotenv();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const {
    EXPERIMENTS,
    CONTROLS,
    COST_SCENARIOS,
    CAPITAL_SCENARIOS,
    EXIT_CADENCES_MIN,
    FROZEN_BUDGET,
    FROZEN_WINDOW,
    PROTOCOL_VERSION,
    protocolHash,
    describeProtocol,
    validateProtocol,
    evaluateAcceptance,
  } = await import("./experiment-configs");
  const { loadHistory } = await import("@/lib/backtest/data");
  const { runBacktest } = await import("@/lib/backtest/engine");
  const { lockHoldout, rollingSplits, selectCandidate, evaluateOnHoldout, dataHash } = await import(
    "@/lib/backtest/walk-forward"
  );
  const { cashBenchmark, buyAndHoldBenchmark } = await import("@/lib/backtest/benchmarks");
  const {
    summarize,
    tradeUncertainty,
    sufficiency,
    compareRuns,
    exitCadenceStudy,
    frameSpacingMinutes,
    formatReport,
    reportHash,
  } = await import("@/lib/backtest/experiment");
  const { STRATEGY_VERSION } = await import("@/lib/strategy/config");
  const { writeFile } = await import("node:fs/promises");
  type VariantRow = import("@/lib/backtest/experiment").VariantRow;

  // 0) A protokoll érvényessége — érvénytelen protokollal nem mérünk.
  const issues = validateProtocol();
  if (issues.length > 0) {
    console.error("ÉRVÉNYTELEN PROTOKOLL — a mérés nem indul:");
    for (const i of issues) console.error(`  - [${i.experimentId}${i.variantId ? `/${i.variantId}` : ""}] ${i.message}`);
    process.exit(1);
    return;
  }
  console.error(describeProtocol());

  // 1) Adat
  const pages = Number(arg("pages") ?? Math.ceil((FROZEN_WINDOW.requestedDays * 24) / 1000));
  console.error(`\nTörténet betöltése: ${FROZEN_WINDOW.symbols.join(", ")}, ${pages} lap…`);
  const { frames, quality } = await loadHistory([...FROZEN_WINDOW.symbols], pages);
  const openQuestions: string[] = [];
  if (frames.length === 0) {
    console.error("Nincs betöltött adat — a mérés NEM ELDÖNTHETŐ. (Hálózat vagy API hiba.)");
    process.exit(2);
    return;
  }
  if (quality.degraded) {
    for (const [sym, q] of Object.entries(quality.bySymbol)) {
      if (q.error || q.gaps > 0) {
        openQuestions.push(
          `Adatminőség ${sym}: ${q.bars} gyertya, ${q.gaps} rés${q.error ? `, hiba: ${q.error}` : ""} — a számok ezzel a korláttal értendők.`,
        );
      }
    }
  }

  const split = lockHoldout(frames, FROZEN_WINDOW.holdoutRatio);
  const development = split.development;
  const spacingMin = frameSpacingMinutes(frames);
  console.error(
    `Betöltve: ${frames.length} keret (fejlesztés ${development.length}, holdout ${split.holdout.length}), ` +
      `felbontás ${spacingMin} perc`,
  );

  // 2) Minden kísérlet minden változata, minden költség- és tőke-forgatókönyvön.
  const rows: VariantRow[] = [];
  const minBars = FROZEN_WINDOW.rolling.trainBars + FROZEN_WINDOW.rolling.validationBars;

  for (const capital of CAPITAL_SCENARIOS) {
    for (const cost of COST_SCENARIOS) {
      const backtestConfig = {
        symbols: [...FROZEN_WINDOW.symbols],
        initialCapitalUsd: capital.initialCapitalUsd,
        feePct: cost.feePct,
        slippageBps: cost.slippageBps,
        minOrderQuote: cost.minOrderQuote,
      };
      const scenario = { costId: cost.id, capitalId: capital.id, executionModel: "polling" };

      for (const exp of EXPERIMENTS) {
        const baselineVariant = exp.variants.find((v) => v.id === "baseline")!;
        const baselineRun = runBacktest(development, backtestConfig, baselineVariant.strategy);
        const baselineSummary = summarize(baselineRun);
        const baselineUnc = tradeUncertainty(baselineRun.realizations);

        for (const v of exp.variants) {
          const run = v.id === "baseline" ? baselineRun : runBacktest(development, backtestConfig, v.strategy);
          const summary = summarize(run);
          const uncertainty = tradeUncertainty(run.realizations);
          rows.push({
            experimentId: exp.id,
            variantId: v.id,
            label: v.label,
            raisesRisk: v.raisesRisk,
            scenario,
            summary,
            uncertainty,
            sufficiency: sufficiency(summary, {
              minClosedTrades: FROZEN_BUDGET.minClosedTrades,
              bars: development.length,
              minBars,
            }),
            comparison:
              v.id === "baseline"
                ? null
                : compareRuns({ summary: baselineSummary, uncertainty: baselineUnc }, { summary, uncertainty }),
          });
        }
      }
    }
  }

  // 3) Kontrollok — nélkülük a pozitív hozam nem jelent semmit.
  const controls: VariantRow[] = [];
  for (const capital of CAPITAL_SCENARIOS) {
    for (const cost of COST_SCENARIOS) {
      const backtestConfig = {
        symbols: [...FROZEN_WINDOW.symbols],
        initialCapitalUsd: capital.initialCapitalUsd,
        feePct: cost.feePct,
        slippageBps: cost.slippageBps,
        minOrderQuote: cost.minOrderQuote,
      };
      const scenario = { costId: cost.id, capitalId: capital.id, executionModel: "polling" };
      const emptyRun = (
        name: string,
        metrics: ReturnType<typeof cashBenchmark>["metrics"],
        equityUsd: number,
        turnoverUsd = 0,
      ) => ({
        experimentId: "control",
        variantId: name,
        label: name,
        raisesRisk: false,
        scenario,
        summary: {
          initialCapitalUsd: capital.initialCapitalUsd,
          finalEquityUsd: equityUsd,
          netReturnPct: metrics.totalReturnPct,
          maxDrawdownPct: metrics.maxDrawdownPct,
          exposurePct: metrics.exposurePct,
          closedTrades: 0,
          realizationCount: 0,
          totalFeesUsd: metrics.totalFeesUsd,
          costPct: equityUsd > 0 ? metrics.totalFeesUsd / equityUsd : 0,
          turnoverUsd,
          turnoverRatio: capital.initialCapitalUsd > 0 ? turnoverUsd / capital.initialCapitalUsd : 0,
          rejections: {},
        },
        uncertainty: null,
        // A kontrollok nem „jelöltek": nincs mintanagyság-követelmény rajtuk.
        sufficiency: { status: "decidable" as const, reason: null },
        comparison: null,
      });

      const cash = cashBenchmark(development, capital.initialCapitalUsd);
      controls.push(emptyRun("cash", cash.metrics, capital.initialCapitalUsd));
      for (const symbol of FROZEN_WINDOW.symbols) {
        const bh = buyAndHoldBenchmark(development, symbol, backtestConfig);
        const last = bh.equityCurve[bh.equityCurve.length - 1]?.equityUsd ?? capital.initialCapitalUsd;
        // A buy & hold EGY vétel: a forgalom az induló tőke, nem nulla.
        controls.push(emptyRun(`buy-and-hold:${symbol}`, bh.metrics, last, capital.initialCapitalUsd));
      }
    }
  }

  // Ha egy tőkeszinten EGYETLEN variáns sem kötött, az nem „nulla hozam", hanem a
  // minimum kötésérték korlátja — ez a mérés legfontosabb kimenete kis tőkén.
  for (const capital of CAPITAL_SCENARIOS) {
    const scoped = rows.filter((r) => r.scenario.capitalId === capital.id);
    if (scoped.length > 0 && scoped.every((r) => r.summary.closedTrades === 0)) {
      const blocked = scoped.reduce((s2, r) => s2 + (r.summary.rejections.below_min_notional ?? 0), 0);
      openQuestions.push(
        `${capital.initialCapitalUsd} USD tőkén EGYETLEN variáns sem kötött (${blocked} order esett a minimum ` +
          "kötésérték alá). Ez nem nulla hozam, hanem azt jelenti, hogy ezen a tőkeszinten a stratégia " +
          "jelenlegi méretezésével nem lehet kereskedni.",
      );
    }
  }

  // Az AI-kontroll csak RÖGZÍTETT döntésekből mérhető; a mai LLM újrafuttatása a régi
  // híreken nem visszajátszás, hanem új kísérlet.
  openQuestions.push(
    `AI-kontroll (${CONTROLS.find((c) => c.id === "ai-free")!.label}): a backteszt AI nélkül fut. ` +
      "Az AI hozzáadott értéke kizárólag rögzített döntések visszajátszásából mérhető " +
      "(`src/lib/backtest/decision-replay.ts`), amihez élő adatbázis kell — ebben a futásban NEM mértük.",
  );

  // 4) Kilépési ütem — izolált vizsgálat, azonos belépésekkel.
  // A kilépési ütemet azon a tőkeszinten mérjük, ahol egyáltalán SZÜLETIK kötés: a
  // 100 USD-s számlán a minimum notional miatt nincs order, ott az ütem-kérdés üres.
  const cadenceCapital = CAPITAL_SCENARIOS[CAPITAL_SCENARIOS.length - 1];
  const cadences = exitCadenceStudy([...EXIT_CADENCES_MIN], spacingMin, () =>
    runBacktest(
      development,
      {
        symbols: [...FROZEN_WINDOW.symbols],
        initialCapitalUsd: cadenceCapital.initialCapitalUsd,
        feePct: COST_SCENARIOS[0].feePct,
        slippageBps: COST_SCENARIOS[0].slippageBps,
        minOrderQuote: COST_SCENARIOS[0].minOrderQuote,
      },
      undefined,
    ),
  );
  for (const c of cadences) {
    if (c.status !== "measured") openQuestions.push(`Kilépési ütem ${c.cadenceMin} perc: ${c.reason}`);
  }

  // 5) Jelentés
  const report: import("@/lib/backtest/experiment").ExperimentReport = {
    protocolVersion: PROTOCOL_VERSION,
    protocolHash: protocolHash(),
    strategyVersion: STRATEGY_VERSION,
    developmentDataHash: dataHash(development),
    holdoutDataHash: dataHash(split.holdout),
    bars: { development: development.length, holdout: split.holdout.length },
    rows,
    controls,
    cadences,
    openQuestions,
    generatedFrom: { frames: frames.length, from: frames[0].ts, to: frames[frames.length - 1].ts },
  };

  let text = formatReport(report);

  // 6) OPCIONÁLIS: a fejlesztési részen kiválasztott nyertes EGYSZERI holdout-mérése.
  if (has("holdout")) {
    const splits = rollingSplits(development, {
      trainBars: FROZEN_WINDOW.rolling.trainBars,
      validationBars: FROZEN_WINDOW.rolling.validationBars,
      stepBars: FROZEN_WINDOW.rolling.stepBars,
    });
    const candidates = EXPERIMENTS.flatMap((e) => e.variants.map((v) => ({ id: `${e.id}/${v.id}`, strategy: v.strategy })));
    // A kiválasztás azon a tőkeszinten fut, ahol egyáltalán SZÜLETIK kötés. A 100 USD-s
    // számlán a minimum notional miatt nincs order, ott a rangsor üres halmazt rangsorolna.
    const selectionCapital = cadenceCapital;
    const baseConfig = {
      symbols: [...FROZEN_WINDOW.symbols],
      initialCapitalUsd: selectionCapital.initialCapitalUsd,
      feePct: COST_SCENARIOS[0].feePct,
      slippageBps: COST_SCENARIOS[0].slippageBps,
      minOrderQuote: COST_SCENARIOS[0].minOrderQuote,
    };
    const selection = selectCandidate(
      candidates,
      splits,
      (c, s) => runBacktest(s.validation, baseConfig, c.strategy),
      { minTradesPerSplit: FROZEN_WINDOW.minTradesPerSplit, developmentDataHash: dataHash(development) },
    );

    if (!selection.winner) {
      const best = selection.ranked[0];
      text +=
        "\n\n## Holdout\n\n" +
        `Tőkeszint: ${selectionCapital.initialCapitalUsd} USD (${selectionCapital.note}).\n\n` +
        `A fejlesztési rész ${selection.splits} szeletén EGYETLEN jelölt sem érte el a szeletenkénti ` +
        `${FROZEN_WINDOW.minTradesPerSplit} kötést, ezért a holdout mérése ELMARAD. ` +
        "A holdout zárolva marad — ez a helyes kimenet, nem hiba.\n\n" +
        (best
          ? `A legjobb rangsorolt jelölt (NEM nyertes): ${best.config.id}, robusztus pontszám ` +
            `${best.robustScore.toFixed(2)}, összesen ${best.totalTrades} kötés a szeleteken.\n`
          : "");
    } else {
      const holdoutReport = evaluateOnHoldout(selection.winner.config, split.holdout, (c, f) =>
        runBacktest(f, baseConfig, c.strategy),
      );
      const holdoutRun = runBacktest(split.holdout, baseConfig, selection.winner.config.strategy);
      const hs = summarize(holdoutRun);
      const bh = buyAndHoldBenchmark(split.holdout, FROZEN_WINDOW.symbols[0], baseConfig);
      const acceptance = evaluateAcceptance({
        netReturnPct: hs.netReturnPct,
        maxDrawdownPct: hs.maxDrawdownPct,
        exposurePct: hs.exposurePct,
        closedTrades: hs.closedTrades,
        totalFeesUsd: hs.totalFeesUsd,
        finalEquityUsd: hs.finalEquityUsd,
        baselineReturnPct: bh.metrics.totalReturnPct,
      });
      text +=
        `\n\n## Holdout (EGYSZERI mérés)\n\n` +
        `- Tőkeszint: ${selectionCapital.initialCapitalUsd} USD (${selectionCapital.note})\n` +
        `- Nyertes a fejlesztési részről: **${selection.winner.config.id}** ` +
        `(robusztus pontszám ${selection.winner.robustScore.toFixed(2)}, ${selection.winner.totalTrades} kötés)\n` +
        `- Holdout adat-hash: ${holdoutReport.holdoutDataHash}, ${holdoutReport.bars} gyertya\n` +
        `- Nettó: ${(hs.netReturnPct * 100).toFixed(2)}%, max DD: ${(hs.maxDrawdownPct * 100).toFixed(2)}%, ` +
        `kötés: ${hs.closedTrades}\n` +
        `- Vak alapvonal (${FROZEN_WINDOW.symbols[0]} buy & hold): ${(bh.metrics.totalReturnPct * 100).toFixed(2)}%\n` +
        `- **Verdikt: ${acceptance.verdict.toUpperCase()}**\n` +
        acceptance.reasons.map((r) => `  - ${r}\n`).join("") +
        `\n> Az „accept" verdikt NEM jelent bekapcsolást: az adoptálás külön felhasználói kockázatdöntés.\n`;
    }
  }

  const out = arg("out");
  if (out) {
    await writeFile(out, text, "utf8");
    console.error(`\nJelentés kiírva: ${out} (jelentés-hash ${reportHash(report)})`);
  } else {
    console.log(text);
  }
}

main().catch((e) => {
  console.error("[compare-strategies] végzetes hiba:", e);
  process.exit(1);
});

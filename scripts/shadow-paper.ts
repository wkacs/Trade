/**
 * Páros, előremenő paper kísérlet indítója (T31).
 *
 * Példák:
 *   pnpm shadow:paper -- --check
 *   pnpm shadow:paper -- --provision
 *   pnpm shadow:paper -- --once
 *   pnpm shadow:paper -- --experiment E5-stop-mode --candidate atr2 --once
 *
 * A `--provision` csak külön v2 paper ledger-scope-okat nyit. A `--once` a baseline
 * hálózati bemenetét egyszer gyűjti be, majd azt replayeli a jelölt(ek)nek. A script
 * sosem fogad el live számlát és sosem ír a régi dashboard-portfólióba.
 */
import { config as dotenv } from "dotenv";

dotenv({ path: ".env.local" });
dotenv();

function option(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const { EXPERIMENTS, protocolHash } = await import("./experiment-configs");
  const { defineShadowSet, validateShadowSet } = await import("@/lib/backtest/shadow-accounts");
  const { runShadowCycle } = await import("@/lib/backtest/shadow-run");
  const { runTick } = await import("@/lib/engine/tick");
  const { getDb } = await import("@/db/client");
  const { hasLedgerState, loadLedgerState } = await import("@/lib/execution/order-store");
  const { equityAt } = await import("@/lib/portfolio/ledger");
  const { dec } = await import("@/lib/portfolio/money");
  const { provisionShadowExperiment, recordShadowCycle, shadowReport } = await import("@/lib/backtest/shadow-store");

  const experimentId = option("experiment") ?? "E5-stop-mode";
  const experiment = EXPERIMENTS.find((e) => e.id === experimentId);
  if (!experiment) throw new Error(`Nincs ilyen kísérlet: ${experimentId}.`);

  const candidateId = option("candidate") ?? experiment.variants.find((v) => v.id !== "baseline")?.id;
  const baseline = experiment.variants.find((v) => v.id === "baseline");
  const candidate = experiment.variants.find((v) => v.id === candidateId && v.id !== "baseline");
  if (!baseline || !candidate) {
    throw new Error(`A ${experimentId} kísérlethez érvényes, nem baseline jelölt kell (--candidate).`);
  }

  const startingCapitalUsd = Number(option("capital") ?? "100");
  if (!Number.isFinite(startingCapitalUsd) || startingCapitalUsd <= 0) {
    throw new Error("A --capital pozitív szám kell legyen.");
  }
  const namespace = option("namespace") ?? `shadow-${experiment.id.toLowerCase()}`;
  const accounts = defineShadowSet(
    { id: "baseline", label: baseline.label, strategy: baseline.strategy, aiEnabled: hasFlag("ai") },
    [{ id: candidate.id, label: candidate.label, strategy: candidate.strategy, aiEnabled: hasFlag("ai") }],
    { namespace, startingCapitalUsd },
  );
  const issues = validateShadowSet(accounts);
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join("\n"));

  const description = {
    protocolHash: protocolHash(),
    experiment: experiment.id,
    candidate: candidate.id,
    namespace,
    accounts: accounts.map((a) => ({
      id: a.id,
      portfolioId: a.portfolioId,
      mode: a.mode,
      startingCapitalUsd: a.startingCapitalUsd,
      aiEnabled: a.aiEnabled,
    })),
    target: { minDays: 30, minRoundTrips: 50 },
    ai: hasFlag("ai")
      ? "AI-s páros mérés: a baseline nyers döntése változatlan decision replayként megy a jelöltnek."
      : "AI nélküli páros kontroll.",
  };

  if (hasFlag("provision")) {
    if (!getDb()) throw new Error("A --provision külön DATABASE_URL-t és migrált PostgreSQL sémát igényel.");
    await provisionShadowExperiment({ namespace, protocolHash: protocolHash(), experimentId: experiment.id,
      candidateId: candidate.id, startingCapital: startingCapitalUsd, accounts: accounts.map((a) => ({ portfolioId: a.portfolioId })) });
  }

  let cycle: { cycleId: string; actions: Record<string, number> } | null = null;
  if (hasFlag("once")) {
    if (!getDb()) throw new Error("A --once külön DATABASE_URL-t és előbb --provisiont igényel.");
    for (const account of accounts) {
      if (!(await hasLedgerState({ portfolioId: account.portfolioId, mode: "paper" }))) {
        throw new Error(`${account.portfolioId} nincs provisionálva. Előbb: pnpm shadow:paper -- --provision`);
      }
    }
    const frozen = await shadowReport(namespace);
    if (frozen.protocolHash !== protocolHash() || frozen.experimentId !== experiment.id || frozen.candidateId !== candidate.id) {
      throw new Error("A provisionált mérés protokollja vagy jelöltje eltér a jelenlegi konfigurációtól. Új namespace kell.");
    }
    const cycleId = new Date().toISOString().replace(/[:.]/g, "-");
    const output = await runShadowCycle(accounts, cycleId, { runTick });
    for (const account of accounts) {
      const result = output.results[account.id];
      const ledger = await loadLedgerState({ portfolioId: account.portfolioId, mode: "paper" });
      const equity = equityAt(ledger, Object.fromEntries(Object.entries(result.prices).map(([s, p]) => [s, dec(p)])));
      await recordShadowCycle({ namespace, cycleId, accountId: account.id, portfolioId: account.portfolioId,
        equityQuote: equity, actions: result.cycleActions.length + (result.trade ? 1 : 0), degraded: result.quotes.degraded,
        incident: result.quotes.staleSkips.length ? { staleSkips: result.quotes.staleSkips } : undefined });
    }
    cycle = {
      cycleId,
      actions: Object.fromEntries(Object.entries(output.results).map(([id, r]) => [id, r.cycleActions.length + (r.trade ? 1 : 0)])),
    };
  }

  const report = hasFlag("report") || hasFlag("once") ? await shadowReport(namespace) : null;
  console.log(JSON.stringify({ ...description, cycle, report }, null, 2));
}

main().catch((error) => {
  console.error(`[shadow-paper] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

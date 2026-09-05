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
  const { defineShadowSet, validateShadowSet, shadowProgress } = await import("@/lib/backtest/shadow-accounts");
  const { runShadowCycle } = await import("@/lib/backtest/shadow-run");
  const { runTick } = await import("@/lib/engine/tick");
  const { getDb } = await import("@/db/client");
  const { hasLedgerState, seedLedger } = await import("@/lib/execution/order-store");
  const { dec } = await import("@/lib/portfolio/money");

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
    { id: "baseline", label: baseline.label, strategy: baseline.strategy, aiEnabled: false },
    [{ id: candidate.id, label: candidate.label, strategy: candidate.strategy, aiEnabled: false }],
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
    ai: "AI nélküli páros kontroll. AI-jelölt csak előre rögzített, megosztott decision replayjel indítható.",
  };

  if (hasFlag("provision")) {
    if (!getDb()) throw new Error("A --provision külön DATABASE_URL-t és migrált PostgreSQL sémát igényel.");
    for (const account of accounts) {
      const scope = { portfolioId: account.portfolioId, mode: "paper" as const };
      if (await hasLedgerState(scope)) {
        throw new Error(`${account.portfolioId} ledger már létezik. Új méréshez adj más --namespace értéket.`);
      }
      await seedLedger(scope, dec(account.startingCapitalUsd), []);
    }
  }

  let cycle: { cycleId: string; actions: Record<string, number> } | null = null;
  if (hasFlag("once")) {
    if (!getDb()) throw new Error("A --once külön DATABASE_URL-t és előbb --provisiont igényel.");
    for (const account of accounts) {
      if (!(await hasLedgerState({ portfolioId: account.portfolioId, mode: "paper" }))) {
        throw new Error(`${account.portfolioId} nincs provisionálva. Előbb: pnpm shadow:paper -- --provision`);
      }
    }
    const cycleId = new Date().toISOString().replace(/[:.]/g, "-");
    const output = await runShadowCycle(accounts, cycleId, { runTick });
    cycle = {
      cycleId,
      actions: Object.fromEntries(Object.entries(output.results).map(([id, r]) => [id, r.cycleActions.length + (r.trade ? 1 : 0)])),
    };
  }

  // A pillanatnyi target csak a futás elindítását jelzi. A tartós, tényleges haladást
  // a dokumentált végső jelentés számolja a DB fill-ledgerből, nem ebből a konzolból.
  const progress = shadowProgress(Date.now(), Date.now(), 0);
  console.log(JSON.stringify({ ...description, cycle, progress: progress.message }, null, 2));
}

main().catch((error) => {
  console.error(`[shadow-paper] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

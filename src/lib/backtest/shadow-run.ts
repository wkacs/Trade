/**
 * Páros forward-paper futtató.
 *
 * A baseline szerzi be egyszer a hálózati bemenetet. A jelöltek ezután ugyanazt a
 * quote- és collector-pillanatképet kapják meg, de saját paper ledgerükre írnak.
 * Ez a kis adapter tartja egy helyen a két fontos határt: nincs live mód és nincs
 * v1 dashboard-vetület az árnyékszámlákról.
 */
import type { TickInput, TickResult } from "@/lib/engine/tick";
import type { PortfolioState } from "@/lib/portfolio/accounting";
import { validateShadowSet, type ShadowAccount } from "./shadow-accounts";

export interface ShadowCycleResult {
  cycleId: string;
  results: Record<string, TickResult>;
}

export interface ShadowRunDeps {
  runTick: (input: TickInput) => Promise<TickResult>;
}

function portfolioState(account: ShadowAccount): PortfolioState {
  const initialCapitalUsd = account.startingCapitalUsd;
  return {
    portfolioId: account.portfolioId,
    initialCapitalUsd,
    cashUsd: initialCapitalUsd,
    positions: [],
    totalEquity: () => initialCapitalUsd,
    dayPnlPct: 0,
  };
}

function tickInput(
  account: ShadowAccount,
  cycleId: string,
  replay?: TickInput["replay"],
  decisionReplay?: TickInput["decisionReplay"],
  observedAt?: number,
): TickInput {
  return {
    // Az intentId globálisan egyedi; a közös logikai cycleId mellé ezért számla-id kerül.
    tickId: `${cycleId}-${account.id}`,
    paperMode: true,
    portfolioState: portfolioState(account),
    strategy: account.strategy,
    strategyVersion: `shadow/${account.id}`,
    aiEnabled: account.aiEnabled,
    replay,
    decisionReplay,
    now: observedAt === undefined ? undefined : () => observedAt,
    legacyProjection: false,
  };
}

/** Egy baseline + jelöltekből álló, azonos bemenetű forward-paper ciklus. */
export async function runShadowCycle(
  accounts: ShadowAccount[],
  cycleId: string,
  deps: ShadowRunDeps,
): Promise<ShadowCycleResult> {
  const issues = validateShadowSet(accounts);
  if (issues.length > 0) throw new Error(`Érvénytelen árnyékszámla-készlet: ${issues.map((i) => i.message).join(" ")}`);

  const baseline = accounts.find((a) => a.isBaseline);
  if (!baseline) throw new Error("Nincs baseline árnyékszámla.");

  const results: Record<string, TickResult> = {};
  const baselineResult = await deps.runTick(tickInput(baseline, cycleId));
  results[baseline.id] = baselineResult;

  for (const candidate of accounts.filter((a) => !a.isBaseline)) {
    results[candidate.id] = await deps.runTick(
      tickInput(
        candidate,
        cycleId,
        baselineResult.replayInput,
        baseline.aiEnabled ? baselineResult.replayInput.rawDecision : undefined,
        baselineResult.replayInput.observedAt,
      ),
    );
  }
  return { cycleId, results };
}

import { DEFAULT_STRATEGY, type StrategyConfig } from "@/lib/strategy/config";
import { defineShadowSet, type ShadowAccount } from "@/lib/backtest/shadow-accounts";
import { runShadowCycle } from "@/lib/backtest/shadow-run";
import { runTick as defaultRunTick } from "@/lib/engine/tick";
import { hasLedgerState, loadLedgerState } from "@/lib/execution/order-store";
import { recordShadowCycle } from "@/lib/backtest/shadow-store";
import { equityAt } from "@/lib/portfolio/ledger";
import { dec } from "@/lib/portfolio/money";

/**
 * ÉLŐ, előre menő árnyék-mérések (T31 folytatása).
 *
 * A visszateszt egyetlen mintát mér egy már megtörtént piacon; ez itt a jövőben méri
 * ugyanazt, valós adatfolyammal, valós költséggel — csak épp papíron. A sáv a fő tick
 * UTÁN fut, hibatűrően: egy árnyék-hiba SOHA nem befolyásolhatja az éles döntést.
 *
 * A jelölt stratégiája szándékosan itt is ki van írva, nem a kísérlet-protokollból
 * importálva (az a `scripts/` alatt él). A `shadow-lanes.test.ts` őrzi, hogy a kettő ne
 * csússzon szét.
 */
export interface ShadowLane {
  namespace: string;
  experimentId: string;
  candidateId: string;
  capitalUsd: number;
  /** AI nélkül: a stratégiát méri tisztán, és nem terheli az LLM ingyenes szintjét. */
  aiEnabled: boolean;
  candidateStrategy: StrategyConfig;
  note: string;
}

/**
 * L2 a kockázat-létráról. A felhasználó kifejezett kockázatvállalási döntése
 * (2026-09-06): a történeti mérésen ez volt az egyetlen lépcső, amely MINDKÉT
 * rezsimben javított az alapvonalhoz képest.
 */
export const ACTIVE_SHADOW_LANES: ShadowLane[] = [
  {
    namespace: "shadow-e6-risk-ladder-l2",
    experimentId: "E6-risk-ladder-L2",
    candidateId: "L2",
    capitalUsd: 320,
    aiEnabled: false,
    candidateStrategy: {
      ...DEFAULT_STRATEGY,
      dcaFgThreshold: 35,
      dcaBuyPct: 0.04,
      dcaWeeklyBudgetPct: 0.2,
      maxPositionPct: 0.35,
      takeProfitPct: 0.25,
      takeProfitFraction: 1,
    },
    note: "FG35 · DCA 4%/heti 20% · max pozíció 35% · TP 25% teljes",
  },
];

export interface ShadowLaneOutcome {
  namespace: string;
  ran: boolean;
  reason?: "not_provisioned" | "error";
  error?: string;
  cycleId?: string;
  actions?: Record<string, number>;
}

export interface ShadowLaneDeps {
  runTick: typeof defaultRunTick;
  hasLedgerState: typeof hasLedgerState;
  loadLedgerState: typeof loadLedgerState;
  recordShadowCycle: typeof recordShadowCycle;
  now: () => Date;
}

const defaultDeps: ShadowLaneDeps = {
  runTick: defaultRunTick,
  hasLedgerState,
  loadLedgerState,
  recordShadowCycle,
  now: () => new Date(),
};

/** Egy sáv számlakészlete: alapvonal (a futó stratégia) + a jelölt. */
export function accountsForLane(lane: ShadowLane): ShadowAccount[] {
  return defineShadowSet(
    { id: "baseline", label: "a jelenlegi éles beállítás", strategy: DEFAULT_STRATEGY, aiEnabled: lane.aiEnabled },
    [{ id: lane.candidateId, label: lane.note, strategy: lane.candidateStrategy, aiEnabled: lane.aiEnabled }],
    { namespace: lane.namespace, startingCapitalUsd: lane.capitalUsd },
  );
}

/**
 * Minden aktív sáv egy ciklusa. SOHA nem dob: a hiba visszaadott adat, nem kivétel,
 * mert ezt a fő tick után hívjuk, és az éles ciklus eredményét nem ronthatja el.
 */
export async function runActiveShadowLanes(
  overrides: Partial<ShadowLaneDeps> = {},
  lanes: ShadowLane[] = ACTIVE_SHADOW_LANES,
): Promise<ShadowLaneOutcome[]> {
  const deps = { ...defaultDeps, ...overrides };
  const out: ShadowLaneOutcome[] = [];

  for (const lane of lanes) {
    try {
      const accounts = accountsForLane(lane);
      for (const account of accounts) {
        if (!(await deps.hasLedgerState({ portfolioId: account.portfolioId, mode: "paper" }))) {
          out.push({ namespace: lane.namespace, ran: false, reason: "not_provisioned" });
          throw new SkipLane();
        }
      }
      const cycleId = deps.now().toISOString().replace(/[:.]/g, "-");
      const result = await runShadowCycle(accounts, cycleId, { runTick: deps.runTick });
      for (const account of accounts) {
        const r = result.results[account.id];
        const ledger = await deps.loadLedgerState({ portfolioId: account.portfolioId, mode: "paper" });
        const equity = equityAt(ledger, Object.fromEntries(Object.entries(r.prices).map(([s, p]) => [s, dec(p)])));
        await deps.recordShadowCycle({
          namespace: lane.namespace,
          cycleId,
          accountId: account.id,
          portfolioId: account.portfolioId,
          equityQuote: equity,
          actions: r.cycleActions.length + (r.trade ? 1 : 0),
          degraded: r.quotes.degraded,
          incident: r.quotes.staleSkips.length ? { staleSkips: r.quotes.staleSkips } : undefined,
        });
      }
      out.push({
        namespace: lane.namespace,
        ran: true,
        cycleId,
        actions: Object.fromEntries(
          Object.entries(result.results).map(([id, r]) => [id, r.cycleActions.length + (r.trade ? 1 : 0)]),
        ),
      });
    } catch (e) {
      if (e instanceof SkipLane) continue;
      console.error(`[shadow-lane] ${lane.namespace} hiba:`, e);
      out.push({ namespace: lane.namespace, ran: false, reason: "error", error: String(e) });
    }
  }
  return out;
}

/** Belső jelzés: a sáv nincs provisionálva, ez nem hiba. */
class SkipLane extends Error {}

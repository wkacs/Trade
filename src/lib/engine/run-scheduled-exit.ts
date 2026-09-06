import { getTradingMode, type TradingMode } from "@/lib/config";
import { loadPortfolioState, type PortfolioState } from "@/lib/portfolio/accounting";
import { runFastExit, type FastExitResult } from "@/lib/engine/fast-exit";
import { acquireLease, releaseLease, leaseKey, slotId, newOwnerId, SLOT_MS, type Lease } from "@/lib/engine/run-lease";

export interface ScheduledExitResult {
  ok: boolean;
  ran: boolean;
  cycleId?: string;
  skipped?: boolean;
  reason?: "lease_held" | "portfolio_missing" | "live_requires_worker" | "cycle_error";
  halted?: string;
  fills?: number;
  stopUpdatesApplied?: number;
  error?: string;
  lease?: { key: string; owner: string; fencingToken: number };
}

interface ScheduledExitDeps {
  getTradingMode: () => TradingMode;
  loadPortfolioState: () => Promise<PortfolioState | null>;
  acquireLease: (key: string, owner: string, ttlMs: number) => Promise<Lease>;
  releaseLease: (key: string, owner: string) => Promise<boolean>;
  runFastExit: typeof runFastExit;
}

const defaultDeps: ScheduledExitDeps = {
  getTradingMode,
  loadPortfolioState,
  acquireLease,
  releaseLease,
  runFastExit,
};

/** Egyetlen, 5 perces paper exit-ciklus a Vercel HTTP cron számára. */
export async function executeScheduledExit(
  options: { now?: () => number; owner?: string } = {},
  dependencyOverrides: Partial<ScheduledExitDeps> = {},
): Promise<ScheduledExitResult> {
  const deps = { ...defaultDeps, ...dependencyOverrides };
  const mode = deps.getTradingMode();

  // A live worker külön Binance-egyeztetést és védőorder-kezelést végez. Enélkül a HTTP
  // route nem nyúlhat valódi számlához; a jelenlegi Vercel deployment paper módú.
  if (mode === "live") {
    return {
      ok: false,
      ran: false,
      reason: "live_requires_worker",
      error: "A Vercel exit-cron csak paper módban fut; live módhoz az állandó worker szükséges.",
    };
  }

  const portfolio = await deps.loadPortfolioState();
  if (!portfolio) {
    return { ok: false, ran: false, reason: "portfolio_missing", error: "Nincs inicializált portfólió." };
  }

  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const slot = slotId(nowMs, SLOT_MS.exit);
  const cycleId = `exit-${slot}`;
  const key = leaseKey("exit", slot);
  const owner = options.owner ?? newOwnerId("exit");
  const ttlMs = Math.floor(SLOT_MS.exit * 0.9);
  const lease = await deps.acquireLease(key, owner, ttlMs);

  if (!lease.acquired) {
    return {
      ok: true,
      ran: false,
      skipped: true,
      reason: "lease_held",
      cycleId,
      lease: { key, owner: lease.heldBy ?? "?", fencingToken: lease.fencingToken },
    };
  }

  try {
    const result: FastExitResult = await deps.runFastExit({
      portfolioId: portfolio.portfolioId,
      mode,
      cycleId,
      now,
      fence: { leaseKey: key, owner, fencingToken: lease.fencingToken },
    });
    return {
      ok: true,
      ran: true,
      cycleId,
      halted: result.halted,
      fills: result.fills.length,
      stopUpdatesApplied: result.stopUpdatesApplied,
      lease: { key, owner, fencingToken: lease.fencingToken },
    };
  } catch (error) {
    await deps.releaseLease(key, owner);
    return {
      ok: false,
      ran: false,
      reason: "cycle_error",
      cycleId,
      error: String(error),
      lease: { key, owner, fencingToken: lease.fencingToken },
    };
  }
}

import { describe, expect, it, vi } from "vitest";
import { executeScheduledExit } from "@/lib/engine/run-scheduled-exit";

const NOW = 1_788_682_800_000;

describe("executeScheduledExit", () => {
  it("paper módban az aktuális 5 perces lease alatt futtatja a gyors kilépést", async () => {
    const acquireLease = vi.fn(async (key: string, owner: string, ttlMs: number) => ({
      key,
      owner,
      fencingToken: 7,
      expiresAtMs: NOW + ttlMs,
      acquired: true,
    }));
    const runFastExit = vi.fn(async () => ({
      cycleId: "exit-test",
      fills: [],
      plan: { exits: [], stopUpdates: [], skipped: [] },
      protectionIncidents: [],
      newBuysBlocked: false,
      quotes: { maxAgeMs: 0, degraded: false, missing: [] },
      halted: "no_positions",
      stopUpdatesApplied: 0,
      rejections: {},
      durationMs: 4,
      protectionOutcomes: [],
    }));

    const result = await executeScheduledExit(
      { now: () => NOW, owner: "exit-test" },
      {
        getTradingMode: () => "paper",
        loadPortfolioState: async () => ({ portfolioId: "pf-1" }) as never,
        acquireLease,
        releaseLease: vi.fn(async () => true),
        runFastExit: runFastExit as never,
      },
    );

    const slot = String(Math.floor(NOW / 300_000) * 300_000);
    expect(acquireLease).toHaveBeenCalledWith(`exit:${slot}`, "exit-test", 270_000);
    expect(runFastExit).toHaveBeenCalledWith(expect.objectContaining({
      portfolioId: "pf-1",
      mode: "paper",
      cycleId: `exit-${slot}`,
      fence: { leaseKey: `exit:${slot}`, owner: "exit-test", fencingToken: 7 },
    }));
    expect(result).toMatchObject({ ok: true, ran: true, halted: "no_positions", fills: 0 });
  });

  it("megtartott lease mellett nem indít második kilépést", async () => {
    const runFastExit = vi.fn();
    const result = await executeScheduledExit(
      { now: () => NOW, owner: "exit-test" },
      {
        getTradingMode: () => "paper",
        loadPortfolioState: async () => ({ portfolioId: "pf-1" }) as never,
        acquireLease: async (key, owner) => ({
          key, owner, fencingToken: 3, expiresAtMs: NOW + 1000, acquired: false, heldBy: "other",
        }),
        releaseLease: vi.fn(async () => true),
        runFastExit: runFastExit as never,
      },
    );

    expect(result).toMatchObject({ ok: true, ran: false, skipped: true, reason: "lease_held" });
    expect(runFastExit).not.toHaveBeenCalled();
  });

  it("live módban fail-closed, mert a HTTP út nem kezelhet valódi exchange ordert", async () => {
    const acquireLease = vi.fn();
    const result = await executeScheduledExit(
      { now: () => NOW },
      {
        getTradingMode: () => "live",
        loadPortfolioState: vi.fn() as never,
        acquireLease,
        releaseLease: vi.fn(async () => true),
        runFastExit: vi.fn() as never,
      },
    );

    expect(result).toMatchObject({ ok: false, ran: false, reason: "live_requires_worker" });
    expect(acquireLease).not.toHaveBeenCalled();
  });
});

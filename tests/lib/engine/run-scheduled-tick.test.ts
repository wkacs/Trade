import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/engine/tick", () => ({ runTick: vi.fn() }));
vi.mock("@/lib/engine/run-lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine/run-lease")>();
  return {
    ...actual,
    acquireLease: vi.fn(),
    releaseLease: vi.fn(async () => true),
  };
});
vi.mock("@/lib/execution/order-store", () => ({ listUnsettledIntents: vi.fn(async () => []) }));
vi.mock("@/lib/portfolio/accounting", () => ({
  insertTickRun: vi.fn(async () => undefined),
  loadPortfolioState: vi.fn(async () => ({
    portfolioId: "pf-test",
    cashUsd: 100,
    initialCapitalUsd: 100,
    positions: [],
    totalEquity: () => 100,
    dayPnlPct: 0,
  })),
}));
vi.mock("@/lib/portfolio/evaluate", () => ({ evaluatePending: vi.fn(async () => ({ evaluated: 0 })) }));
vi.mock("@/lib/ops/heartbeat", () => ({ pingHeartbeat: vi.fn(async () => undefined) }));
// A DB-t explicit mockoljuk: a „van DB" ágakhoz nem akarunk valódi hálózati hívást.
vi.mock("@/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/client")>();
  return { ...actual, getDb: vi.fn(() => null), getSql: vi.fn(() => null) };
});

import { runTick } from "@/lib/engine/tick";
import { acquireLease, releaseLease, slotId, leaseKey } from "@/lib/engine/run-lease";
import { listUnsettledIntents } from "@/lib/execution/order-store";
import { pingHeartbeat } from "@/lib/ops/heartbeat";
import { getDb } from "@/db/client";
/** Egy minimális, lekérdezésre üres tömböt adó DB-attrapp. */
const fakeDb = () => {
  const chain: any = { from: () => chain, where: () => chain, limit: async () => [] };
  return { select: () => chain } as any;
};
import { executeScheduledTick, currentTickId } from "@/lib/engine/run-scheduled-tick";

const NOW = Date.UTC(2026, 8, 5, 10, 7, 0);

const tickResult = {
  events: [],
  decision: { id: "d", timestamp: NOW, action: "HOLD" as const, symbol: "", amountPct: 0, confidence: 0.3, reasoning: "x", model: "m", overridden: false },
  trade: null,
  positionId: null,
  rawAction: "HOLD" as const,
  rawAmountPct: 0,
  prices: { BTC: 60000 },
  cycleActions: [],
  process: {} as never,
  tradingEnabled: true,
  dayGate: { dayUtc: "2026-09-05", source: "day-open", dayPnlPct: 0, latched: false, blockNewBuys: false, reason: "" },
  inceptionPnlPct: 0,
};

describe("executeScheduledTick — lease és kizárás", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (runTick as any).mockResolvedValue(tickResult);
    (acquireLease as any).mockResolvedValue({
      key: "entry:x",
      owner: "me",
      fencingToken: 1,
      expiresAtMs: NOW + 1000,
      acquired: true,
    });
    (listUnsettledIntents as any).mockResolvedValue([]);
    (getDb as any).mockReturnValue(null);
  });

  it("a tick id UTC óra szerint képződik", () => {
    expect(currentTickId(new Date(NOW))).toBe("2026-09-05-10");
  });

  it("DB nélkül is lefut (lease nem szerezhető, de nincs mit kizárni)", async () => {
    (getDb as any).mockReturnValue(null);
    const r = await executeScheduledTick({ now: () => NOW, owner: "me" });
    expect(r.ok).toBe(true);
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it("a lease kulcsa idősávonként külön van (belépés ≠ kilépés)", () => {
    const slot = slotId(NOW, 60 * 60 * 1000);
    expect(leaseKey("entry", slot)).not.toBe(leaseKey("exit", slot));
    // Ugyanabban az órában ugyanaz a sáv.
    expect(slotId(NOW, 60 * 60 * 1000)).toBe(slotId(NOW + 20 * 60_000, 60 * 60 * 1000));
    // A következő órában már másik.
    expect(slotId(NOW, 60 * 60 * 1000)).not.toBe(slotId(NOW + 60 * 60_000, 60 * 60 * 1000));
  });

  it("ismeretlen állapotú megbízás mellett NEM indul új ciklus", async () => {
    (listUnsettledIntents as any).mockResolvedValue([{ intentId: "i-1", state: "unknown" }]);
    // Ehhez DB kell, hogy az ellenőrzés lefusson.
    (getDb as any).mockReturnValue(fakeDb());
    const r = await executeScheduledTick({ now: () => NOW, owner: "me" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unsettled_intents");
    expect(r.unsettledIntents).toBe(1);
    expect(runTick).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalled();
    expect(pingHeartbeat).toHaveBeenCalledWith(false);
  });

  it("ha MÁS tartja a lease-t, kihagyjuk a futást", async () => {
    (acquireLease as any).mockResolvedValue({
      key: "entry:x",
      owner: "me",
      fencingToken: 3,
      expiresAtMs: NOW + 1000,
      acquired: false,
      heldBy: "masik-runner",
    });
    (getDb as any).mockReturnValue(fakeDb());
    const r = await executeScheduledTick({ now: () => NOW, owner: "me" });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("lease_held");
    expect(runTick).not.toHaveBeenCalled();
  });

  it("ciklushiba esetén elengedi a lease-t és hibás heartbeatet küld", async () => {
    (runTick as any).mockRejectedValue(new Error("boom"));
    const r = await executeScheduledTick({ now: () => NOW, owner: "me" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom/);
    expect(releaseLease).toHaveBeenCalled();
    expect(pingHeartbeat).toHaveBeenCalledWith(false);
  });

  it("sikeres futás után a lease BENT MARAD (tartós claim az idősávra)", async () => {
    await executeScheduledTick({ now: () => NOW, owner: "me" });
    expect(releaseLease).not.toHaveBeenCalled();
  });
});

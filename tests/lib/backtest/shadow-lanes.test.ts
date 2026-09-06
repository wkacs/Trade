import { describe, it, expect, vi } from "vitest";
import {
  ACTIVE_SHADOW_LANES,
  accountsForLane,
  runActiveShadowLanes,
  type ShadowLane,
} from "@/lib/backtest/shadow-lanes";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import { EXPERIMENTS } from "../../../scripts/experiment-configs";

describe("aktív árnyék-sávok", () => {
  it("a sáv stratégiája megegyezik a rögzített kísérleti protokollal", () => {
    // Ez a teszt a DRIFT ellen véd: a futó sáv és a leírt kísérlet nem válhat szét.
    for (const lane of ACTIVE_SHADOW_LANES) {
      const experiment = EXPERIMENTS.find((e) => e.id === lane.experimentId);
      expect(experiment, `nincs ilyen kísérlet: ${lane.experimentId}`).toBeTruthy();
      const variant = experiment!.variants.find((v) => v.id === lane.candidateId);
      expect(variant, `nincs ilyen változat: ${lane.candidateId}`).toBeTruthy();
      expect(lane.candidateStrategy).toEqual(variant!.strategy);
    }
  });

  it("az alapvonal a FUTÓ stratégia, nem egy másolat", () => {
    const accounts = accountsForLane(ACTIVE_SHADOW_LANES[0]);
    const baseline = accounts.find((a) => a.isBaseline)!;
    expect(baseline.strategy).toEqual(DEFAULT_STRATEGY);
  });
});

const lane: ShadowLane = {
  namespace: "teszt-sav",
  experimentId: "X",
  candidateId: "cand",
  capitalUsd: 320,
  aiEnabled: false,
  candidateStrategy: { ...DEFAULT_STRATEGY, maxPositionPct: 0.35 },
  note: "teszt",
};

describe("runActiveShadowLanes — a fő tick nem sérülhet", () => {
  it("provisionálatlan sávot kihagy, nem dob", async () => {
    const out = await runActiveShadowLanes(
      { hasLedgerState: vi.fn(async () => false) as never, runTick: vi.fn() as never },
      [lane],
    );
    expect(out).toEqual([{ namespace: "teszt-sav", ran: false, reason: "not_provisioned" }]);
  });

  it("a sávban dobott hibát adatként adja vissza, nem kivételként", async () => {
    const out = await runActiveShadowLanes(
      {
        hasLedgerState: vi.fn(async () => true) as never,
        // A DB-olvasás mockolva: a teszt a TICK hibájára fókuszál, nem a kapcsolatra.
        shadowReport: vi.fn(async () => ({ experimentId: "X", candidateId: "cand" })) as never,
        runTick: vi.fn(async () => {
          throw new Error("tick robbant");
        }) as never,
      },
      [lane],
    );
    expect(out[0].ran).toBe(false);
    expect(out[0].reason).toBe("error");
    expect(out[0].error).toContain("tick robbant");
  });
});

describe("sáv-azonosság", () => {
  it("nem futtat olyan namespace-t, amit MÁS kísérlethez provisionáltak", async () => {
    const out = await runActiveShadowLanes(
      {
        hasLedgerState: vi.fn(async () => true) as never,
        shadowReport: vi.fn(async () => ({ experimentId: "MÁS", candidateId: "X" })) as never,
        runTick: vi.fn() as never,
      },
      [lane],
    );
    expect(out[0].ran).toBe(false);
    expect(out[0].reason).toBe("identity_mismatch");
  });
});

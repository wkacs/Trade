import { describe, it, expect } from "vitest";
import { insertTickRun } from "@/lib/portfolio/accounting";
import type { TickProcess } from "@/lib/engine/tick-process";

const proc: TickProcess = {
  tickId: "2026-06-28-11",
  inputs: { prices: { BTC: 60000 }, fearGreed: null, mlSignals: [] },
  cycleActions: [],
  phase1: { shouldDecide: false, summary: "x" },
  phase2: null,
  decision: { action: "HOLD", symbol: null, overridden: false, overrideReason: null },
  trades: [],
};

describe("insertTickRun", () => {
  it("beszúrja a tickId + process párost a tick_runs-ba", async () => {
    let captured: unknown = null;
    const mockDb = { insert: () => ({ values: async (v: unknown) => { captured = v; } }) } as never;
    await insertTickRun("2026-06-28-11", proc, mockDb);
    expect(captured).toEqual({ tickId: "2026-06-28-11", process: proc });
  });

  it("DB nélkül (null) nem dob és nem csinál semmit", async () => {
    await expect(insertTickRun("x", proc, null)).resolves.toBeUndefined();
  });
});

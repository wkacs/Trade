import { describe, it, expect } from "vitest";
import { executeScheduledStockTick } from "@/lib/engine/run-scheduled-stock-tick";

// A teszt-környezetben nincs DATABASE_URL → getDb() null. Így a cadence- és a no-db-kaput
// determinisztikusan ellenőrizhetjük, valós DB nélkül.

const MARKET_OPEN = Date.parse("2026-02-02T15:00:00Z"); // 10:00 ET → ülés nyitva
const AFTER_HOURS = Date.parse("2026-02-02T22:30:00Z"); // 17:30 ET → after-hours

describe("executeScheduledStockTick – kapuk (DB nélkül)", () => {
  it("nyitott piacon a cadence kihagyja (nem esedékes)", async () => {
    const res = await executeScheduledStockTick({ now: () => MARKET_OPEN });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("cadence:market-open");
  });

  it("after-hours + DB hiánya → no_database skip (a cadence átengedte)", async () => {
    const res = await executeScheduledStockTick({ now: () => AFTER_HOURS });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("no_database");
  });

  it("--force átengedi a cadence-t, de DB nélkül no_database", async () => {
    const res = await executeScheduledStockTick({ now: () => MARKET_OPEN, force: true });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("no_database");
  });

  it("a tickId az ET kereskedési nap", async () => {
    const res = await executeScheduledStockTick({ now: () => AFTER_HOURS });
    expect(res.tickId).toBe("2026-02-02");
  });
});

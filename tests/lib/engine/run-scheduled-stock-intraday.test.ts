import { describe, it, expect } from "vitest";
import { executeScheduledStockIntraday, INTRADAY_SLOT_MS } from "@/lib/engine/run-scheduled-stock-intraday";

// A teszt-környezetben nincs DATABASE_URL → getDb() null. Így az ülés- és a no-db-kapu
// determinisztikusan ellenőrizhető, valós DB nélkül.

const PRE_MARKET = Date.parse("2026-02-02T14:00:00Z"); // 09:00 ET
const MID_SESSION = Date.parse("2026-02-02T15:00:00Z"); // 10:00 ET
const NEAR_CLOSE = Date.parse("2026-02-02T20:55:00Z"); // 15:55 ET
const WEEKEND = Date.parse("2026-02-01T18:00:00Z");

describe("executeScheduledStockIntraday – kapuk (DB nélkül)", () => {
  it("zárt piacon kihagyja, az okot megnevezve", async () => {
    const res = await executeScheduledStockIntraday({ now: () => PRE_MARKET });
    expect(res).toMatchObject({ ok: true, skipped: true, phase: "closed", reason: "session:pre-market" });
  });

  it("hétvégén sem fut", async () => {
    const res = await executeScheduledStockIntraday({ now: () => WEEKEND });
    expect(res.reason).toBe("session:weekend");
  });

  it("ülés közben átengedi a kapu, de DB nélkül no_database", async () => {
    const res = await executeScheduledStockIntraday({ now: () => MID_SESSION });
    expect(res).toMatchObject({ ok: true, skipped: true, phase: "trading", reason: "no_database" });
  });

  it("zárás előtt a fázis flatten (a laposra zárás akkor is esedékes)", async () => {
    const res = await executeScheduledStockIntraday({ now: () => NEAR_CLOSE });
    expect(res.phase).toBe("flatten");
    expect(res.reason).toBe("no_database");
  });

  it("--force zárt piacon is átengedi a ciklust", async () => {
    const res = await executeScheduledStockIntraday({ now: () => PRE_MARKET, force: true });
    expect(res.reason).toBe("no_database");
  });

  it("az idősáv 5 perces és a slot az 5 perces rácsra esik", async () => {
    const res = await executeScheduledStockIntraday({ now: () => MID_SESSION });
    expect(INTRADAY_SLOT_MS).toBe(5 * 60 * 1000);
    expect(Number(res.slot) % INTRADAY_SLOT_MS).toBe(0);
  });
});

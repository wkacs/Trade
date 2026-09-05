import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { resetSchema, truncateAll, testSql } from "./db-helpers";
import { acquireLease, releaseLease, isFenced, leaseKey, slotId, SLOT_MS } from "@/lib/engine/run-lease";

/**
 * T10 — a lease valódi PostgreSQL ellen.
 *
 * Amit bizonyít:
 *  - egyszerre EGY tulajdonos futhat egy kulcson (cron és worker együtt indítva);
 *  - a lejárt lease átvehető, és ilyenkor a fencing token NŐ;
 *  - az azonos tulajdonos megújít, a token nem nő (a saját heartbeat nem fence-el ki);
 *  - a belépési és a kilépési idősáv KÜLÖN kulcs, nem zárják ki egymást.
 */
describe("run-lease — valódi PostgreSQL", () => {
  const NOW = Date.UTC(2026, 8, 5, 10, 7, 0);

  beforeAll(async () => {
    await resetSchema();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  });

  it("két egyidejű futóból pontosan egy szerzi meg a lease-t", async () => {
    const key = leaseKey("entry", slotId(NOW, SLOT_MS.entry));
    const [a, b] = await Promise.all([acquireLease(key, "cron", 60_000), acquireLease(key, "worker", 60_000)]);
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
    const rows = (await testSql()`SELECT count(*)::int AS c FROM run_leases`) as { c: number }[];
    expect(rows[0].c).toBe(1);
  });

  it("az azonos tulajdonos MEGÚJÍT, a fencing token nem nő", async () => {
    const key = "entry:renew";
    const first = await acquireLease(key, "same", 60_000);
    const second = await acquireLease(key, "same", 60_000);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(second.fencingToken).toBe(first.fencingToken);
  });

  it("a LEJÁRT lease átvehető, és a token nő (a régi futó kifenceleve)", async () => {
    const key = "entry:expire";
    const first = await acquireLease(key, "old", 1);
    expect(first.acquired).toBe(true);
    // Lejárattatjuk közvetlenül, hogy ne kelljen várni.
    await testSql()`UPDATE run_leases SET expires_at = now() - interval '1 second' WHERE lease_key = ${key}`;

    const second = await acquireLease(key, "new", 60_000);
    expect(second.acquired).toBe(true);
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);

    // A régi tulajdonos felismeri, hogy elavult.
    expect(await isFenced(key, first.fencingToken)).toBe(true);
    expect(await isFenced(key, second.fencingToken)).toBe(false);
  });

  it("az ÉLŐ lease-t más nem veheti át", async () => {
    const key = "entry:held";
    await acquireLease(key, "owner-a", 60_000);
    const other = await acquireLease(key, "owner-b", 60_000);
    expect(other.acquired).toBe(false);
    expect(other.heldBy).toBe("owner-a");
  });

  it("csak a tulajdonos engedheti el a lease-t", async () => {
    const key = "entry:release";
    await acquireLease(key, "owner-a", 60_000);
    expect(await releaseLease(key, "owner-b")).toBe(false);
    expect(await releaseLease(key, "owner-a")).toBe(true);
    const after = await acquireLease(key, "owner-b", 60_000);
    expect(after.acquired).toBe(true);
  });

  it("a belépési és a kilépési sáv külön kulcs — nem zárják ki egymást", async () => {
    const entry = leaseKey("entry", slotId(NOW, SLOT_MS.entry));
    const exit = leaseKey("exit", slotId(NOW, SLOT_MS.exit));
    const a = await acquireLease(entry, "entry-runner", 60_000);
    const b = await acquireLease(exit, "exit-runner", 60_000);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });
});

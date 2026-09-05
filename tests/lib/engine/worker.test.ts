import { describe, it, expect, vi } from "vitest";
import { TradingWorker, nextSlotStart, currentSlot, type WorkerDeps, type WorkerEvent, type WorkerConfig } from "@/lib/engine/worker";
import { leaseKey, slotId, SLOT_MS, type Lease } from "@/lib/engine/run-lease";

const MIN = 60_000;
/** 2026-09-05 10:00:00 UTC */
const T0 = Date.UTC(2026, 8, 5, 10, 0, 0);

function lease(acquired = true): Lease {
  return { key: "k", owner: "me", fencingToken: 1, expiresAtMs: 0, acquired };
}

/** Vezérelhető óra és alvás: a teszt nem vár valós időt. */
function fakeClock(start: number) {
  let now = start;
  const sleepers: { at: number; resolve: () => void; signal: { aborted: boolean } }[] = [];
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const s of [...sleepers]) {
        if (s.at <= now || s.signal.aborted) {
          sleepers.splice(sleepers.indexOf(s), 1);
          s.resolve();
        }
      }
    },
    sleep: (ms: number, signal: { aborted: boolean }) =>
      new Promise<void>((resolve) => {
        if (signal.aborted || ms <= 0) return resolve();
        sleepers.push({ at: now + ms, resolve, signal });
      }),
    pending: () => sleepers.length,
  };
}

function makeWorker(over: Partial<WorkerDeps> = {}, config: Partial<WorkerConfig> = {}) {
  const clock = fakeClock(T0);
  const events: WorkerEvent[] = [];
  const deps: WorkerDeps = {
    now: clock.now,
    sleep: clock.sleep,
    acquireLease: async () => lease(true),
    releaseLease: async () => true,
    runExit: async () => {},
    runEntry: async () => {},
    onEvent: (e) => events.push(e),
    ...over,
  };
  const worker = new TradingWorker(
    { portfolioId: "pf", mode: "paper", exitIntervalMs: 5 * MIN, entryIntervalMs: 60 * MIN, entryOffsetMs: 7 * MIN, ...config },
    deps,
  );
  return { worker, clock, events, deps };
}

describe("időzítés — a KÖVETKEZŐ sáv, sosem a régi", () => {
  it("nextSlotStart a következő sávkezdetet adja", () => {
    expect(nextSlotStart(T0, 5 * MIN)).toBe(T0 + 5 * MIN);
    expect(nextSlotStart(T0 + 2 * MIN, 5 * MIN)).toBe(T0 + 5 * MIN);
  });

  it("az offset eltolja a sávkezdetet (órás gyertya záródása után)", () => {
    // :07-es offset mellett 10:00-kor a következő futás 10:07.
    expect(nextSlotStart(T0, 60 * MIN, 7 * MIN)).toBe(T0 + 7 * MIN);
    // 10:10-kor már a 11:07 következik.
    expect(nextSlotStart(T0 + 10 * MIN, 60 * MIN, 7 * MIN)).toBe(T0 + 67 * MIN);
  });

  it("éjfél-átlépés nem töri el a sávot", () => {
    const beforeMidnight = Date.UTC(2026, 8, 5, 23, 58, 0);
    expect(nextSlotStart(beforeMidnight, 5 * MIN)).toBe(Date.UTC(2026, 8, 6, 0, 0, 0));
  });

  it("a JELENLEGI sáv azonosítója óraugrás után is a mostani", () => {
    const a = currentSlot(T0, 5 * MIN);
    const b = currentSlot(T0 + 2 * MIN, 5 * MIN);
    const c = currentSlot(T0 + 6 * MIN, 5 * MIN);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("runOnce — egyszeri futás, lease-szel", () => {
  it("lefut, ha megkapja a lease-t", async () => {
    const runExit = vi.fn(async () => {});
    const { worker } = makeWorker({ runExit });
    const r = await worker.runOnce("exit");
    expect(r.ran).toBe(true);
    expect(runExit).toHaveBeenCalledTimes(1);
    expect(worker.stats.exit.runs).toBe(1);
  });

  it("a megszerzett lease fencing adatait és az összetett vételi kaput adja a ciklusnak", async () => {
    const runEntry = vi.fn(async () => {});
    const { worker } = makeWorker({
      acquireLease: async (key, owner) => ({ key, owner, fencingToken: 42, expiresAtMs: T0 + MIN, acquired: true }),
      runEntry,
    }, { owner: "worker-fixed" });
    worker.updateProtectionGate(false, "nincs védelem");
    await worker.runOnce("entry");
    const context = (runEntry as any).mock.calls[0][1];
    expect(context).toMatchObject({ owner: "worker-fixed", fencingToken: 42, allowNewBuys: false });
    expect(context.leaseKey).toMatch(/^entry:/);
  });

  it("NEM fut, ha más tartja a lease-t", async () => {
    const runExit = vi.fn(async () => {});
    const { worker } = makeWorker({ acquireLease: async () => lease(false), runExit });
    const r = await worker.runOnce("exit");
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("lease_held");
    expect(runExit).not.toHaveBeenCalled();
    expect(worker.stats.exit.skippedLease).toBe(1);
  });

  it("hiba esetén elengedi a lease-t és számolja a hibát", async () => {
    const releaseLease = vi.fn(async () => true);
    const { worker, events } = makeWorker({
      runExit: async () => {
        throw new Error("boom");
      },
      releaseLease,
    });
    await worker.runOnce("exit");
    expect(releaseLease).toHaveBeenCalled();
    expect(worker.stats.exit.errors).toBe(1);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("a hiba nem állítja meg a workert (a következő ciklus indulhat)", async () => {
    let calls = 0;
    const { worker } = makeWorker({
      runExit: async () => {
        calls++;
        if (calls === 1) throw new Error("első hiba");
      },
    });
    await worker.runOnce("exit");
    const second = await worker.runOnce("exit");
    expect(second.ran).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("átfedés — a hosszú belépés nem fogja meg a kilépést", () => {
  it("ugyanaz a fajta NEM indul újra, amíg fut", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { worker } = makeWorker({ runEntry: () => gate });

    const first = worker.runOnce("entry");
    // Az átfedés-őr szinkron zár, ezért a második hívás azonnal visszatér.
    const second = await worker.runOnce("entry");
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("overlap");
    release();
    await first;
    expect(worker.stats.entry.skippedOverlap).toBe(1);
  });

  it("a FUTÓ belépés mellett a kilépés akadálytalanul lefut", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runExit = vi.fn(async () => {});
    const { worker } = makeWorker({ runEntry: () => gate, runExit });

    const entry = worker.runOnce("entry");
    const exit = await worker.runOnce("exit");
    expect(exit.ran).toBe(true);
    expect(runExit).toHaveBeenCalledTimes(1);
    release();
    await entry;
  });

  it("a belépés és a kilépés KÜLÖN lease-kulcsot használ", async () => {
    const keys: string[] = [];
    const { worker } = makeWorker({
      acquireLease: async (key) => {
        keys.push(key);
        return lease(true);
      },
    });
    await worker.runOnce("entry");
    await worker.runOnce("exit");
    expect(keys[0].startsWith("entry:")).toBe(true);
    expect(keys[1].startsWith("exit:")).toBe(true);
  });
});

describe("hurok, késés és leállítás", () => {
  it("a hurok a sávkezdetkor futtat, és nem pótolja a kihagyott sávokat", async () => {
    const slots: string[] = [];
    const { worker, clock } = makeWorker({ runExit: async (slot) => void slots.push(slot) });

    const started = worker.start();
    // Az első sávkezdetig alszik.
    clock.advance(5 * MIN);
    await Promise.resolve();
    // Nagy ugrás: 3 sávnyi idő telik el egyszerre (pl. a gép aludt).
    clock.advance(15 * MIN);
    await Promise.resolve();
    worker.stop();
    clock.advance(60 * MIN);
    await started;

    // Legfeljebb annyi futás, ahányszor ébredtünk — a kihagyott sávokat NEM pótoljuk.
    expect(slots.length).toBeLessThanOrEqual(3);
    const unique = new Set(slots);
    expect(unique.size).toBe(slots.length);
  });

  it("a leállítás után új ciklus nem indul", async () => {
    const runExit = vi.fn(async () => {});
    const { worker, clock } = makeWorker({ runExit });
    const started = worker.start();
    worker.stop();
    clock.advance(60 * MIN);
    await started;
    expect(worker.isRunning()).toBe(false);
    expect(runExit).not.toHaveBeenCalled();
  });

  it("a leállítás eseményei megjelennek", async () => {
    const { worker, clock, events } = makeWorker();
    const started = worker.start();
    worker.stop();
    clock.advance(60 * MIN);
    await started;
    expect(events.map((e) => e.type)).toContain("started");
    expect(events.map((e) => e.type)).toContain("stopping");
    expect(events.map((e) => e.type)).toContain("stopped");
  });

  it("a ciklusok időtartama mérhető", async () => {
    const { worker, clock } = makeWorker({
      runExit: async () => {
        clock.advance(1234);
      },
    });
    await worker.runOnce("exit");
    expect(worker.stats.exit.lastDurationMs).toBe(1234);
  });
});

describe("induláskori egyeztetés (T27)", () => {
  it("indításkor lefut, és az eredménye szabályozza az új vételt", async () => {
    const reconcile = vi.fn(async () => ({ safeToBuy: false, summary: "eltérés a tőzsdével" }));
    const { worker, clock } = makeWorker({ reconcile });
    const started = worker.start();
    await Promise.resolve();
    worker.stop();
    clock.advance(60 * MIN);
    await started;

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(worker.canBuy()).toBe(false);
    expect(worker.lastReconcileSummary).toMatch(/eltérés/);
  });

  it("sikeres egyeztetés után szabad a vétel", async () => {
    const { worker } = makeWorker({ reconcile: async () => ({ safeToBuy: true, summary: "rendben" }) });
    expect(await worker.reconcileNow()).toBe(true);
    expect(worker.canBuy()).toBe(true);
  });

  it("hibára futó egyeztetés KONZERVATÍV: a vétel tiltott marad", async () => {
    const { worker } = makeWorker({
      reconcile: async () => {
        throw new Error("exchange down");
      },
    });
    expect(await worker.reconcileNow()).toBe(false);
    expect(worker.lastReconcileSummary).toMatch(/ÚJ VÉTEL TILOS/);
  });

  it("egyeztető nélkül a worker nem tiltja a vételt (paper mód)", async () => {
    const { worker } = makeWorker();
    expect(await worker.reconcileNow()).toBe(true);
  });
});

describe("egy aktív scheduler — a worker és a cron NEM dupláz (T28)", () => {
  /**
   * A `executeScheduledTick` (cron route és `scripts/tick.ts`) offset NÉLKÜL számol
   * sávot: `leaseKey("entry", slotId(now, SLOT_MS.entry))`. Ha a worker az offsettel
   * számolna, ugyanarra az órára MÁS kulcsot kapna, és a lease nem zárná ki egymást.
   */
  const cronKey = (nowMs: number) => leaseKey("entry", slotId(nowMs, SLOT_MS.entry));

  it("a worker belépési kulcsa MEGEGYEZIK a cron kulcsával a :07-es indításnál", () => {
    const at = Date.UTC(2026, 8, 5, 14, 7, 0);
    expect(leaseKey("entry", currentSlot(at, SLOT_MS.entry))).toBe(cronKey(at));
  });

  it("az egész órán belül végig ugyanaz a kulcs (késve induló futás is)", () => {
    for (const min of [7, 12, 30, 59]) {
      const at = Date.UTC(2026, 8, 5, 14, min, 0);
      expect(leaseKey("entry", currentSlot(at, SLOT_MS.entry))).toBe(cronKey(Date.UTC(2026, 8, 5, 14, 7, 0)));
    }
  });

  it("a következő óra MÁS kulcs (az óránkénti futás nem esik ki)", () => {
    const a = leaseKey("entry", currentSlot(Date.UTC(2026, 8, 5, 14, 7, 0), SLOT_MS.entry));
    const b = leaseKey("entry", currentSlot(Date.UTC(2026, 8, 5, 15, 7, 0), SLOT_MS.entry));
    expect(a).not.toBe(b);
  });

  it("ha a cron már elvitte a sávot, a worker belépése kimarad", async () => {
    const held: Record<string, string> = { [cronKey(T0)]: "tick-runner" };
    const { worker } = makeWorker(
      {
        acquireLease: async (key, owner, ttl) => {
          if (held[key] && held[key] !== owner) {
            return { key, owner, fencingToken: 1, expiresAtMs: 0, acquired: false, heldBy: held[key] };
          }
          held[key] = owner;
          return { key, owner, fencingToken: 1, expiresAtMs: ttl, acquired: true, heldBy: owner };
        },
      },
      { entryIntervalMs: SLOT_MS.entry },
    );
    const r = await worker.runOnce("entry");
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("lease_held");
    expect(worker.stats.entry.runs).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSchedulerRole, isSchedulerRoleValid, schedulerGuard } from "@/lib/config";

/**
 * T28 — PONTOSAN EGY aktív ütemező.
 *
 * A lease (T10) második védvonalként kizárja a dupla futást, de a konfigurációnak is
 * egyértelműnek kell lennie: melyik folyamat AZ ütemező. Elgépelt érték nem csúszhat át
 * csendben egy default-ra úgy, hogy közben a másik folyamat is fut.
 */
describe("schedulerGuard", () => {
  const original = process.env.SCHEDULER;

  beforeEach(() => {
    delete process.env.SCHEDULER;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SCHEDULER;
    else process.env.SCHEDULER = original;
  });

  it("alapértelmezés a github-actions (ez fut ma, ingyen)", () => {
    expect(getSchedulerRole()).toBe("github-actions");
    expect(schedulerGuard("github-actions").active).toBe(true);
  });

  it("a worker NEM aktív, amíg a beállítás github-actions", () => {
    const g = schedulerGuard("worker");
    expect(g.active).toBe(false);
    expect(g.configured).toBe("github-actions");
    expect(g.message).toMatch(/EGY aktív ütemező/);
  });

  it("SCHEDULER=worker esetén a worker aktív, a GitHub-tick pedig NEM", () => {
    process.env.SCHEDULER = "worker";
    expect(schedulerGuard("worker").active).toBe(true);
    expect(schedulerGuard("github-actions").active).toBe(false);
  });

  it("egyszerre soha nem lehet két aktív szerep", () => {
    for (const role of ["worker", "github-actions", "vercel-cron"] as const) {
      process.env.SCHEDULER = role;
      const actives = (["worker", "github-actions", "vercel-cron"] as const).filter((r) => schedulerGuard(r).active);
      expect(actives).toEqual([role]);
    }
  });

  it("az ELGÉPELT érték nem csúszik át csendben: egyik szerep sem aktív", () => {
    process.env.SCHEDULER = "wroker";
    expect(isSchedulerRoleValid()).toBe(false);
    for (const role of ["worker", "github-actions", "vercel-cron"] as const) {
      const g = schedulerGuard(role);
      expect(g.active).toBe(false);
      expect(g.message).toMatch(/Ismeretlen SCHEDULER/);
    }
  });

  it("a körülvevő szóköz nem számít elgépelésnek", () => {
    process.env.SCHEDULER = " worker ";
    expect(getSchedulerRole()).toBe("worker");
    expect(schedulerGuard("worker").active).toBe(true);
  });
});

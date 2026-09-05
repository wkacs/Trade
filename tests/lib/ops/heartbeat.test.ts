import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pingHeartbeat,
  shouldSend,
  emptyHeartbeatState,
  emptyOpsHealth,
  emptyCycleHealth,
  applyCycleReport,
  stalenessMs,
  isSilent,
  resetHeartbeatState,
  type HeartbeatState,
} from "@/lib/ops/heartbeat";

const NOW = 1_700_000_000_000;

describe("pingHeartbeat — env nélkül no-op, sosem dob", () => {
  beforeEach(() => {
    resetHeartbeatState();
    delete process.env.HEARTBEAT_URL;
  });

  it("HEARTBEAT_URL nélkül nem hív hálózatot", async () => {
    const fetchImpl = vi.fn();
    const r = await pingHeartbeat(true, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });
    expect(r).toBe("no_url");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("siker esetén az alap URL-t, hiba esetén a /fail végpontot hívja", async () => {
    process.env.HEARTBEAT_URL = "https://hc.example/abc";
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    const state: HeartbeatState = emptyHeartbeatState();

    await pingHeartbeat(true, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW, state });
    expect(fetchImpl).toHaveBeenCalledWith("https://hc.example/abc");

    await pingHeartbeat(false, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW + 1000,
      state,
      errorCode: "boom",
    });
    expect(fetchImpl).toHaveBeenLastCalledWith("https://hc.example/abc/fail");
  });

  it("hálózati hiba nem dob", async () => {
    process.env.HEARTBEAT_URL = "https://hc.example/abc";
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const r = await pingHeartbeat(true, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });
    expect(r).toBe("failed");
  });
});

describe("riasztás-deduplikáció (T23)", () => {
  it("UGYANAZ a hiba nem megy ki minden tickben", () => {
    const state = emptyHeartbeatState();
    expect(shouldSend(state, false, "persist_failed", NOW)).toBe(true);
    state.lastStatus = "fail";
    state.lastErrorCode = "persist_failed";
    state.lastSentAtMs = NOW;
    expect(shouldSend(state, false, "persist_failed", NOW + 60_000)).toBe(false);
  });

  it("MÁS hiba viszont azonnal kimegy", () => {
    const state: HeartbeatState = { lastStatus: "fail", lastErrorCode: "persist_failed", lastSentAtMs: NOW, suppressed: 0 };
    expect(shouldSend(state, false, "cycle_error", NOW + 1000)).toBe(true);
  });

  it("a helyreállás (fail → ok) mindig kimegy", () => {
    const state: HeartbeatState = { lastStatus: "fail", lastErrorCode: "x", lastSentAtMs: NOW, suppressed: 0 };
    expect(shouldSend(state, true, null, NOW + 1000)).toBe(true);
  });

  it("hosszú azonos állapot után életjelként újra kimegy", () => {
    const state: HeartbeatState = { lastStatus: "ok", lastErrorCode: null, lastSentAtMs: NOW, suppressed: 0 };
    expect(shouldSend(state, true, null, NOW + 30 * 60_000)).toBe(false);
    expect(shouldSend(state, true, null, NOW + 61 * 60_000)).toBe(true);
  });

  it("az elnyomott pingek számláltak", async () => {
    const state = emptyHeartbeatState();
    await pingHeartbeat(false, { state, now: () => NOW, errorCode: "e" });
    const r = await pingHeartbeat(false, { state, now: () => NOW + 1000, errorCode: "e" });
    expect(r).toBe("suppressed_duplicate");
    expect(state.suppressed).toBe(1);
  });
});

describe("ops health — futási állapot (T23)", () => {
  it("sikeres ciklus frissíti az utolsó siker idejét és nullázza a hibaszámot", () => {
    let h = emptyOpsHealth();
    h = applyCycleReport(h, { kind: "exit", ok: false, startedAtMs: NOW, durationMs: 10, error: "boom" });
    expect(h.exit.consecutiveFailures).toBe(1);
    h = applyCycleReport(h, { kind: "exit", ok: true, startedAtMs: NOW + 1000, durationMs: 20 });
    expect(h.exit.consecutiveFailures).toBe(0);
    expect(h.exit.lastSuccessAtMs).toBe(NOW + 1000);
    expect(h.exit.lastError).toBeNull();
  });

  it("az ütemező késése a tervezett és a tényleges indulás különbsége", () => {
    const h = applyCycleReport(emptyOpsHealth(), {
      kind: "entry",
      ok: true,
      startedAtMs: NOW + 45_000,
      scheduledAtMs: NOW,
      durationMs: 100,
    });
    expect(h.schedulerDelayMs.entry).toBe(45_000);
    expect(h.schedulerDelayMs.exit).toBeNull();
  });

  it("a belépés és a kilépés állapota KÜLÖN követett", () => {
    let h = emptyOpsHealth();
    h = applyCycleReport(h, { kind: "exit", ok: true, startedAtMs: NOW, durationMs: 5 });
    expect(h.exit.lastSuccessAtMs).toBe(NOW);
    expect(h.entry.lastSuccessAtMs).toBeNull();
  });

  it("a quote-kor és az adatkimaradás átvezetődik", () => {
    const h = applyCycleReport(emptyOpsHealth(), {
      kind: "exit",
      ok: true,
      startedAtMs: NOW,
      durationMs: 5,
      quoteAgeMs: 1200,
      degradedSources: ["rss"],
      blockedReason: null,
    });
    expect(h.quoteAgeMs).toBe(1200);
    expect(h.degradedSources).toEqual(["rss"]);
  });

  it("a MÉG SOSEM futott ciklus nem „friss”, hanem ismeretlen", () => {
    const c = emptyCycleHealth();
    expect(stalenessMs(c, NOW)).toBeNull();
    expect(isSilent(c, NOW, 5 * 60_000)).toBeNull();
  });

  it("elhallgatott ciklus felismerhető", () => {
    const c = { ...emptyCycleHealth(), lastSuccessAtMs: NOW };
    expect(isSilent(c, NOW + 5 * 60_000, 5 * 60_000)).toBe(false);
    expect(isSilent(c, NOW + 20 * 60_000, 5 * 60_000)).toBe(true);
  });
});

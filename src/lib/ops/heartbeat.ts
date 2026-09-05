/**
 * Dead-man's-switch heartbeat és futási állapot (T23).
 *
 * USER-SETUP (külső, egyszeri):
 *   1) healthchecks.io → új check: period 1h, grace ~90 perc.
 *   2) másold a ping-URL-t HEARTBEAT_URL néven a runner/worker környezetébe.
 *   3) állítsd be a riasztás-csatornát a healthchecks.io-n.
 * Amíg nincs beállítva, ez a kód csendben no-op — semmi nem törik.
 *
 * T23 VÁLTOZÁS:
 *  - SIKERES heartbeat CSAK akkor megy ki, ha a könyvelés is sikerült. A régi kód a
 *    mentési hiba után is zöldet pingelt.
 *  - A riasztás nem ismétli ugyanazt a hibát minden tickben: azonos hibakód mellett
 *    csak az ELSŐ ping megy ki, és a helyreállás külön eseményként látszik.
 */

export type HeartbeatOutcome = "sent" | "suppressed_duplicate" | "no_url" | "failed";

export interface HeartbeatState {
  /** Az utolsó kiküldött állapot. */
  lastStatus: "ok" | "fail" | null;
  /** Az utolsó hibakód — ugyanaz nem megy ki újra. */
  lastErrorCode: string | null;
  lastSentAtMs: number | null;
  suppressed: number;
}

export function emptyHeartbeatState(): HeartbeatState {
  return { lastStatus: null, lastErrorCode: null, lastSentAtMs: null, suppressed: 0 };
}

/** Modul-szintű állapot a folyamat élettartamára (a worker egy folyamatban fut). */
let moduleState: HeartbeatState = emptyHeartbeatState();

/** Tiszta döntés: ki kell-e küldeni ezt a heartbeatet? */
export function shouldSend(
  state: HeartbeatState,
  ok: boolean,
  errorCode: string | null,
  nowMs: number,
  repeatAfterMs = 60 * 60 * 1000,
): boolean {
  const status = ok ? "ok" : "fail";
  if (state.lastStatus !== status) return true; // állapotváltás mindig kimegy
  if (!ok && state.lastErrorCode !== errorCode) return true; // MÁS hiba: kimegy
  // Azonos állapot és azonos hiba: csak ritkán ismételjük (életjel a monitornak).
  return state.lastSentAtMs === null || nowMs - state.lastSentAtMs >= repeatAfterMs;
}

export interface PingOptions {
  /** A hiba azonosítója. Azonos kód nem ismétlődik minden tickben. */
  errorCode?: string | null;
  now?: () => number;
  fetchImpl?: typeof fetch;
  state?: HeartbeatState;
  repeatAfterMs?: number;
}

/**
 * Heartbeat ping. `ok=false` esetén a `/fail` végpontra megy.
 * Best-effort: env nélkül no-op, hibát elnyel, SOHA nem dob.
 */
export async function pingHeartbeat(ok: boolean, options: PingOptions = {}): Promise<HeartbeatOutcome> {
  const url = process.env.HEARTBEAT_URL;
  const now = options.now ?? (() => Date.now());
  const state = options.state ?? moduleState;
  const errorCode = options.errorCode ?? null;

  if (!shouldSend(state, ok, errorCode, now(), options.repeatAfterMs)) {
    state.suppressed++;
    return "suppressed_duplicate";
  }

  state.lastStatus = ok ? "ok" : "fail";
  state.lastErrorCode = ok ? null : errorCode;
  state.lastSentAtMs = now();

  if (!url) return "no_url";
  try {
    const doFetch = options.fetchImpl ?? fetch;
    await doFetch(ok ? url : `${url}/fail`);
    return "sent";
  } catch (e) {
    console.error("[heartbeat] ping hiba:", e);
    return "failed";
  }
}

/** Teszthez és worker-újraindításhoz: az állapot nullázása. */
export function resetHeartbeatState(): void {
  moduleState = emptyHeartbeatState();
}

export function heartbeatState(): HeartbeatState {
  return moduleState;
}

// ── Futási állapot (ops health) ─────────────────────────────────────────────

export interface CycleHealth {
  /** Az utolsó SIKERES futás ideje (epoch ms). null = még sosem futott le sikeresen. */
  lastSuccessAtMs: number | null;
  lastAttemptAtMs: number | null;
  lastDurationMs: number | null;
  /** Hány ciklus óta nincs siker. */
  consecutiveFailures: number;
  lastError: string | null;
}

export interface OpsHealth {
  entry: CycleHealth;
  exit: CycleHealth;
  /** A tervezett és a tényleges indulás közti késés ms-ban (ütemező-pontosság). */
  schedulerDelayMs: { entry: number | null; exit: number | null };
  /** A legutóbbi quote-kor ms-ban. null = nem mérhető. */
  quoteAgeMs: number | null;
  /** Adatkimaradás: mely források hibáztak legutóbb. */
  degradedSources: string[];
  /** Miért nem kereskedünk (ha nem). */
  blockedReason: string | null;
}

export function emptyCycleHealth(): CycleHealth {
  return { lastSuccessAtMs: null, lastAttemptAtMs: null, lastDurationMs: null, consecutiveFailures: 0, lastError: null };
}

export function emptyOpsHealth(): OpsHealth {
  return {
    entry: emptyCycleHealth(),
    exit: emptyCycleHealth(),
    schedulerDelayMs: { entry: null, exit: null },
    quoteAgeMs: null,
    degradedSources: [],
    blockedReason: null,
  };
}

export interface CycleReport {
  kind: "entry" | "exit";
  ok: boolean;
  startedAtMs: number;
  durationMs: number;
  /** A sáv TERVEZETT kezdete — ebből jön az ütemező késése. */
  scheduledAtMs?: number;
  error?: string | null;
  quoteAgeMs?: number | null;
  degradedSources?: string[];
  blockedReason?: string | null;
}

/** Tiszta állapotátmenet: egy ciklus jelentése → új ops-állapot. */
export function applyCycleReport(health: OpsHealth, report: CycleReport): OpsHealth {
  const cycle = { ...health[report.kind] };
  cycle.lastAttemptAtMs = report.startedAtMs;
  cycle.lastDurationMs = report.durationMs;
  if (report.ok) {
    cycle.lastSuccessAtMs = report.startedAtMs;
    cycle.consecutiveFailures = 0;
    cycle.lastError = null;
  } else {
    cycle.consecutiveFailures += 1;
    cycle.lastError = report.error ?? "ismeretlen hiba";
  }
  return {
    ...health,
    [report.kind]: cycle,
    schedulerDelayMs: {
      ...health.schedulerDelayMs,
      [report.kind]:
        report.scheduledAtMs !== undefined ? Math.max(0, report.startedAtMs - report.scheduledAtMs) : health.schedulerDelayMs[report.kind],
    },
    quoteAgeMs: report.quoteAgeMs !== undefined ? report.quoteAgeMs : health.quoteAgeMs,
    degradedSources: report.degradedSources ?? health.degradedSources,
    blockedReason: report.blockedReason !== undefined ? report.blockedReason : health.blockedReason,
  };
}

/** Mennyi ideje nem volt sikeres futás? null = még sosem futott. */
export function stalenessMs(cycle: CycleHealth, nowMs: number): number | null {
  return cycle.lastSuccessAtMs === null ? null : nowMs - cycle.lastSuccessAtMs;
}

/**
 * Elhallgatott-e a ciklus? A küszöb a sáv hosszának többszöröse.
 * Ha MÉG SOSEM futott le sikeresen, az NEM „friss": külön, ismeretlen állapot.
 */
export function isSilent(cycle: CycleHealth, nowMs: number, expectedIntervalMs: number, tolerance = 2): boolean | null {
  if (cycle.lastSuccessAtMs === null) return null;
  return nowMs - cycle.lastSuccessAtMs > expectedIntervalMs * tolerance;
}

/**
 * Állandó ütemező worker (T22).
 *
 * Az audit B. szakasza szerint a gyors kilépéshez állandó folyamat, egységes zárolás és
 * időkorlátos hálózati hívások kellenek. A GitHub Actions cron ráadásul terhelés alatt
 * késik, ezért a pontos 5 perces ciklus nem bízható rá.
 *
 * Amit ez a modul garantál:
 *  - KÉT FÜGGETLEN ciklus: 5 perces kilépés és 60 perces (lezárt gyertyás) belépés.
 *    A hosszú belépés (LLM) SOHA nem fogja meg a kilépést — külön hurok, külön lease.
 *  - Nincs átfedő futás: amíg egy ciklus dolgozik, ugyanaz a fajta nem indul újra.
 *    (A régi `setInterval` async callbackkel pontosan ezt engedte meg.)
 *  - Késés vagy újraindulás után NEM dolgozunk fel régi idősávokat visszamenőleg:
 *    mindig a JELENLEGI sávot vesszük.
 *  - Leállítás (SIGTERM) tiszta: a folyamatban lévő ciklus befejeződik, új nem indul.
 *
 * Minden IO injektált — az idő, az alvás, a lease és a két ciklus is. Így a worker
 * determinisztikusan tesztelhető, valódi várakozás nélkül.
 */
import { leaseKey, slotId, newOwnerId, SLOT_MS, type Lease, type RunKind } from "@/lib/engine/run-lease";

export interface WorkerConfig {
  portfolioId: string;
  mode: "paper" | "live";
  /** A kilépés-ciklus hossza (alap: 5 perc). */
  exitIntervalMs?: number;
  /** A belépés-ciklus hossza (alap: 60 perc). */
  entryIntervalMs?: number;
  /**
   * Ennyivel a sáv kezdete UTÁN indul a belépés. Az órás gyertya záródása után adunk
   * időt az adatnak; a régi cron :07-kor futott, ezt tartjuk.
   */
  entryOffsetMs?: number;
  /** A lease élettartama a sáv hosszának hányadaként. */
  leaseTtlRatio?: number;
  owner?: string;
}

export type WorkerEvent =
  | { type: "started"; owner: string; at: number }
  | { type: "stopping"; at: number }
  | { type: "stopped"; at: number }
  | { type: "cycle-start"; kind: RunKind; slot: string; at: number }
  | { type: "cycle-end"; kind: RunKind; slot: string; at: number; durationMs: number; ok: boolean }
  | { type: "skipped"; kind: RunKind; slot: string; reason: "overlap" | "lease_held"; at: number }
  | { type: "error"; kind: RunKind; slot: string; message: string; at: number };

export interface WorkerDeps {
  now: () => number;
  /**
   * Induláskori és periodikus egyeztetés (T27). Igaz visszatérés = biztonságos folytatni.
   * Hamis esetén az ÚJ VÉTEL tiltott; a kilépés és a védelem továbbra is működik.
   */
  reconcile?: () => Promise<{ safeToBuy: boolean; summary: string }>;
  /** Alvás a megadott ms-ig. A `signal` a leállításkor megszakítja. */
  sleep: (ms: number, signal: { aborted: boolean }) => Promise<void>;
  acquireLease: (key: string, owner: string, ttlMs: number) => Promise<Lease>;
  releaseLease: (key: string, owner: string) => Promise<boolean>;
  runExit: (slot: string) => Promise<void>;
  runEntry: (slot: string) => Promise<void>;
  onEvent?: (event: WorkerEvent) => void;
}

/** A KÖVETKEZŐ sávkezdet (offsettel). Ha épp most van, a következőt adja. */
export function nextSlotStart(nowMs: number, intervalMs: number, offsetMs = 0): number {
  const base = Math.floor((nowMs - offsetMs) / intervalMs) * intervalMs + offsetMs;
  return base > nowMs ? base : base + intervalMs;
}

/**
 * A JELENLEGI sáv azonosítója. Késés után is EZ fut, nem a kihagyott régi sávok.
 *
 * SZÁNDÉKOSAN NINCS benne az offset: a sáv a fali óra szerinti idősáv (pl. a 14:00–15:00
 * óra), az offset csak azt mondja meg, a sávon BELÜL mikor indulunk (:07). Ha az offset
 * beleszámítana, a worker és a cron route (`executeScheduledTick`, ami offset nélkül
 * számol) KÜLÖNBÖZŐ lease-kulcsot kapna ugyanarra az órára, és mindkettő lefutna.
 */
export function currentSlot(nowMs: number, intervalMs: number): string {
  return slotId(nowMs, intervalMs);
}

export interface CycleStats {
  runs: number;
  skippedOverlap: number;
  skippedLease: number;
  errors: number;
  lastSlot: string | null;
  lastDurationMs: number | null;
}

export class TradingWorker {
  private running = false;
  private signal = { aborted: false };
  private inFlight: Record<RunKind, boolean> = { entry: false, exit: false, reconcile: false };
  private loops: Promise<void>[] = [];
  readonly owner: string;
  readonly stats: Record<"entry" | "exit", CycleStats> = {
    entry: { runs: 0, skippedOverlap: 0, skippedLease: 0, errors: 0, lastSlot: null, lastDurationMs: null },
    exit: { runs: 0, skippedOverlap: 0, skippedLease: 0, errors: 0, lastSlot: null, lastDurationMs: null },
  };

  constructor(
    private config: WorkerConfig,
    private deps: WorkerDeps,
  ) {
    this.owner = config.owner ?? newOwnerId("worker");
  }

  private emit(event: WorkerEvent) {
    this.deps.onEvent?.(event);
  }

  private intervalFor(kind: "entry" | "exit"): number {
    return kind === "entry"
      ? (this.config.entryIntervalMs ?? SLOT_MS.entry)
      : (this.config.exitIntervalMs ?? SLOT_MS.exit);
  }

  private offsetFor(kind: "entry" | "exit"): number {
    return kind === "entry" ? (this.config.entryOffsetMs ?? 7 * 60_000) : 0;
  }

  /**
   * EGY ciklus futtatása a JELENLEGI sávra. Külön hívható a tesztből és az egyszeri
   * futtatáshoz (`--once`), a hurok nélkül.
   */
  async runOnce(kind: "entry" | "exit"): Promise<{ ran: boolean; slot: string; reason?: "overlap" | "lease_held" }> {
    const interval = this.intervalFor(kind);
    const slot = currentSlot(this.deps.now(), interval);
    const key = leaseKey(kind, slot);

    // Az átfedés-őr SZINKRON módon zár: a lease-lekérés is hálózati hívás, ezért két
    // egyszerre indított ciklus e nélkül mindkettő átjutna rajta.
    if (this.inFlight[kind]) {
      this.stats[kind].skippedOverlap++;
      this.emit({ type: "skipped", kind, slot, reason: "overlap", at: this.deps.now() });
      return { ran: false, slot, reason: "overlap" };
    }
    this.inFlight[kind] = true;

    const ttl = Math.max(1000, Math.floor(interval * (this.config.leaseTtlRatio ?? 0.9)));
    let lease: Lease;
    try {
      lease = await this.deps.acquireLease(key, this.owner, ttl);
    } catch (e) {
      this.inFlight[kind] = false;
      this.stats[kind].errors++;
      this.emit({ type: "error", kind, slot, message: String(e), at: this.deps.now() });
      return { ran: false, slot, reason: "lease_held" };
    }
    if (!lease.acquired) {
      this.inFlight[kind] = false;
      this.stats[kind].skippedLease++;
      this.emit({ type: "skipped", kind, slot, reason: "lease_held", at: this.deps.now() });
      return { ran: false, slot, reason: "lease_held" };
    }

    const started = this.deps.now();
    this.emit({ type: "cycle-start", kind, slot, at: started });
    let ok = true;
    try {
      if (kind === "entry") await this.deps.runEntry(slot);
      else await this.deps.runExit(slot);
    } catch (e) {
      ok = false;
      this.stats[kind].errors++;
      this.emit({ type: "error", kind, slot, message: String(e), at: this.deps.now() });
      // Hibánál elengedjük a lease-t, hogy a következő sáv előtt még lehessen próbálkozni.
      await this.deps.releaseLease(key, this.owner);
    } finally {
      this.inFlight[kind] = false;
    }

    const durationMs = this.deps.now() - started;
    this.stats[kind].runs++;
    this.stats[kind].lastSlot = slot;
    this.stats[kind].lastDurationMs = durationMs;
    this.emit({ type: "cycle-end", kind, slot, at: this.deps.now(), durationMs, ok });
    return { ran: true, slot };
  }

  /** Egy hurok: a KÖVETKEZŐ sávkezdetig alszik, majd a JELENLEGI sávot futtatja. */
  private async loop(kind: "entry" | "exit"): Promise<void> {
    const interval = this.intervalFor(kind);
    const offset = this.offsetFor(kind);
    while (this.running) {
      const now = this.deps.now();
      const next = nextSlotStart(now, interval, offset);
      await this.deps.sleep(Math.max(0, next - now), this.signal);
      if (!this.running) break;
      // Késés után is a JELENLEGI sávot futtatjuk — kihagyott régi sávokat sosem.
      await this.runOnce(kind);
    }
  }

  /** Igaz, ha az utolsó egyeztetés szerint biztonságos új vételt indítani. */
  private buysAllowed = true;

  /** Az utolsó egyeztetés összefoglalója (naplóhoz és állapotjelzéshez). */
  lastReconcileSummary: string | null = null;

  /** Az egyeztetés lefuttatása. Hiba esetén KONZERVATÍV: a vétel tiltott marad. */
  async reconcileNow(): Promise<boolean> {
    if (!this.deps.reconcile) return this.buysAllowed;
    try {
      const r = await this.deps.reconcile();
      this.buysAllowed = r.safeToBuy;
      this.lastReconcileSummary = r.summary;
    } catch (e) {
      this.buysAllowed = false;
      this.lastReconcileSummary = `Az egyeztetés hibára futott: ${String(e)} — ÚJ VÉTEL TILOS.`;
    }
    return this.buysAllowed;
  }

  /** Szabad-e új vételt indítani az utolsó egyeztetés szerint? */
  canBuy(): boolean {
    return this.buysAllowed;
  }

  /** A worker indítása. A visszaadott ígéret a leállásig fut. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.signal = { aborted: false };
    this.emit({ type: "started", owner: this.owner, at: this.deps.now() });
    // INDULÁSKORI EGYEZTETÉS: a nyitott orderek és az egyenleg összevetése a tőzsdével.
    await this.reconcileNow();
    this.loops = [this.loop("exit"), this.loop("entry")];
    await Promise.all(this.loops);
    this.emit({ type: "stopped", at: this.deps.now() });
  }

  /** Leállítás: új ciklus nem indul, a folyamatban lévő befejeződik. */
  stop(): void {
    if (!this.running) return;
    this.emit({ type: "stopping", at: this.deps.now() });
    this.running = false;
    this.signal.aborted = true;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Fut-e épp valamelyik ciklus (a leállás megvárásához). */
  isBusy(): boolean {
    return this.inFlight.entry || this.inFlight.exit;
  }
}

/** Megszakítható alvás valós időben. */
export function realSleep(ms: number, signal: { aborted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    const check = setInterval(() => {
      if (signal.aborted) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 250);
    // A folyamat leállását ne akadályozza a figyelő.
    if (typeof timer === "object" && "unref" in timer) (timer as { unref: () => void }).unref();
    if (typeof check === "object" && "unref" in check) (check as { unref: () => void }).unref();
  });
}

import type { DataPoint } from "@/lib/types";

export interface DataCollector {
  name: string;
  collect(): Promise<DataPoint[]>;
  /**
   * Strukturált hiba az utolsó lekérésből, ha volt — akkor is, ha a collector NEM dobott.
   * Enélkül egy elutasított forrás `ok: true, points: 0` alakban jelenik meg, és a
   * dashboard „rendben"-t ír, miközben a jel-lánc adat nélkül maradt.
   */
  lastError?(): string | null;
}

export interface CollectorOutcome {
  name: string;
  ok: boolean;
  points: number;
  durationMs: number;
  error?: string;
}

export interface CollectResult {
  points: DataPoint[];
  outcomes: CollectorOutcome[];
  /** Igaz, ha BÁRMELYIK collector hibázott vagy időtúllépett — mérhető állapot. */
  degraded: boolean;
}

/** Alapértelmezett collector-időkorlát: egy lassú hírforrás nem foghatja meg a ciklust. */
export const DEFAULT_COLLECTOR_TIMEOUT_MS = 15_000;

/** Időkorlátos ígéret. Túllépéskor a megadott hibával utasít el. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: időtúllépés (${timeoutMs} ms)`)), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Az összes regisztrált collectort párhuzamosan lefuttatja, EGYENKÉNTI időkorláttal.
 *
 * T14: a részleges hiba nem tűnik el — a kimenet tartalmazza, melyik forrás mit adott,
 * és mennyi ideig futott. Egy collector hibája nem dönti romba a ciklust (spec §3.1),
 * de a `degraded` jelzés láthatóvá teszi.
 *
 * FONTOS: a VÉGREHAJTÁSI ár NEM innen jön. Azt a `market/quotes.ts` külön, rövid
 * időkorláttal kéri le, hogy a kilépés ne várjon hírre vagy sentimentre.
 */
export async function collectAllWithOutcomes(
  collectors: DataCollector[],
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<CollectResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());

  const settled = await Promise.allSettled(
    collectors.map(async (c) => {
      const started = now();
      try {
        const points = await withTimeout(c.collect(), timeoutMs, c.name);
        // A néma (nem dobott) forrás-hiba is hiba: a részleges adat sem „rendben".
        const reported = c.lastError?.() ?? null;
        return {
          name: c.name,
          ok: reported === null,
          points,
          durationMs: now() - started,
          error: reported ?? undefined,
        };
      } catch (e) {
        return { name: c.name, ok: false, points: [] as DataPoint[], durationMs: now() - started, error: String(e) };
      }
    }),
  );

  const points: DataPoint[] = [];
  const outcomes: CollectorOutcome[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      points.push(...r.value.points);
      outcomes.push({
        name: r.value.name,
        ok: r.value.ok,
        points: r.value.points.length,
        durationMs: r.value.durationMs,
        error: r.value.error,
      });
      if (!r.value.ok) console.error(`[collectAll] ${r.value.name} hiba:`, r.value.error);
    } else {
      outcomes.push({ name: "ismeretlen", ok: false, points: 0, durationMs: 0, error: String(r.reason) });
      console.error("[collectAll] collector hiba:", r.reason);
    }
  }
  return { points, outcomes, degraded: outcomes.some((o) => !o.ok) };
}

/** Visszafelé kompatibilis alak (csak az adatpontok). */
export async function collectAll(collectors: DataCollector[]): Promise<DataPoint[]> {
  return (await collectAllWithOutcomes(collectors)).points;
}

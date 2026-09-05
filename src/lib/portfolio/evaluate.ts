import { getDb, schema } from "@/db/client";
import { and, isNull, isNotNull, lt, gte, lte, eq, asc } from "drizzle-orm";

/** Döntéskori pillanatkép (a decisions.ref oszlopban). */
export interface DecisionRef {
  prices: Record<string, number>;
  /** Az AI VALÓDI szándéka a Risk Manager ELŐTT (rawAction) — mit akart tényleg. */
  intent: "BUY" | "SELL" | "HOLD";
  intentSymbol: string | null;
  intentAmountPct: number;
}

/**
 * Utólagos kiértékelés (a decisions.outcome oszlopban).
 *
 * FONTOS (T20): ez IRÁNYTALÁLAT-diagnosztika, NEM realizált profit. Az audit C. szakasza
 * kifogásolta, hogy a régi kód a KÖVETKEZŐ tetszőleges tick árával pontozott: több napos
 * üzemszünet után a „1 órás" találat valójában több napos elmozdulást mért.
 *
 * Itt a horizont kötött: a pontozás CSAK akkor történik meg, ha van ár a döntés + horizont
 * környékén, a megengedett tűréshatáron belül. Egyébként a döntés `unscored` marad.
 */
export interface DecisionOutcome {
  /** A CÉLZOTT horizont órában (nem a tényleges eltelt idő). */
  horizonHours: number;
  /** A pontozáshoz ténylegesen használt ár eltérése a céltól, órában. */
  horizonErrorHours: number;
  refSymbol: string | null;
  /** A coin árváltozása % a döntés óta a HORIZONT árához mérve. */
  changePct: number;
  /** Irányra vonatkozó diagnosztika: BUY → +change, SELL → -change. NEM profit. */
  directionalScorePct: number;
  /** Eltalálta-e az IRÁNYT? HOLD-nál null (semleges). */
  directionHit: boolean | null;
  /** Miért nem pontozható, ha nem az. */
  unscored?: "stale_horizon" | "missing_price" | "no_intent";
}

export interface ScoreOptions {
  /** A célzott horizont órában. Alapértelmezés 1. */
  horizonHours?: number;
  /**
   * Mennyivel térhet el a felhasznált ár ideje a horizonttól. Ezen túl NEM pontozunk:
   * egy több napos üzemszünet utáni ár nem 1 órás előrejelzést mér.
   */
  toleranceHours?: number;
}

const DEFAULT_HORIZON_HOURS = 1;
const DEFAULT_TOLERANCE_HOURS = 0.5;

/**
 * Egy döntés IRÁNY-pontozása a HORIZONT árán. Tiszta függvény.
 *
 * @param priceAtHorizon a coin ára a döntés + horizont időpontban, és annak TÉNYLEGES ideje
 */
export function scoreDecision(
  ref: DecisionRef,
  priceAtHorizon: { price: number | null; atMs: number | null },
  decisionTsMs: number,
  options: ScoreOptions = {},
): DecisionOutcome {
  const horizonHours = options.horizonHours ?? DEFAULT_HORIZON_HOURS;
  const tolerance = options.toleranceHours ?? DEFAULT_TOLERANCE_HOURS;
  const sym = ref.intentSymbol;

  const base: DecisionOutcome = {
    horizonHours,
    horizonErrorHours: 0,
    refSymbol: sym,
    changePct: 0,
    directionalScorePct: 0,
    directionHit: null,
  };

  if (ref.intent === "HOLD" || !sym) {
    return { ...base, refSymbol: null, unscored: "no_intent" };
  }
  const refP = ref.prices?.[sym];
  if (!refP || !priceAtHorizon.price || priceAtHorizon.atMs === null) {
    return { ...base, unscored: "missing_price" };
  }

  const actualHours = (priceAtHorizon.atMs - decisionTsMs) / 3_600_000;
  const errorHours = actualHours - horizonHours;
  if (Math.abs(errorHours) > tolerance) {
    // Hosszú üzemszünet utáni árral NEM pontozunk 1 órás döntést.
    return { ...base, horizonErrorHours: errorHours, unscored: "stale_horizon" };
  }

  const changePct = ((priceAtHorizon.price - refP) / refP) * 100;
  const directionalScorePct = ref.intent === "BUY" ? changePct : -changePct;
  return {
    horizonHours,
    horizonErrorHours: errorHours,
    refSymbol: sym,
    changePct,
    directionalScorePct,
    directionHit: directionalScorePct > 0,
  };
}

/** Egy időbélyeges ár-sorozat, amiből a horizont ára kikereshető. */
export interface PricePoint {
  ts: number;
  price: number;
}

/**
 * A HORIZONT árának megkeresése: a célidőhöz LEGKÖZELEBBI pont, a tűréshatáron belül.
 * Nincs találat → `null`, nem a legfrissebb ár.
 */
export function priceAtHorizon(
  series: PricePoint[],
  decisionTsMs: number,
  horizonHours = DEFAULT_HORIZON_HOURS,
  toleranceHours = DEFAULT_TOLERANCE_HOURS,
): { price: number | null; atMs: number | null } {
  const target = decisionTsMs + horizonHours * 3_600_000;
  const toleranceMs = toleranceHours * 3_600_000;
  let best: PricePoint | null = null;
  for (const p of series) {
    if (Math.abs(p.ts - target) > toleranceMs) continue;
    if (!best || Math.abs(p.ts - target) < Math.abs(best.ts - target)) best = p;
  }
  return best ? { price: best.price, atMs: best.ts } : { price: null, atMs: null };
}

/**
 * Kiértékeli a már beérett döntéseket a HORIZONT árával — a tick_runs naplóból vett
 * időbélyeges árakból, nem az „aktuális" árral.
 *
 * A régi implementáció az AKTUÁLIS árat használta, ezért egy több napos kimaradás után
 * a pontozás értelmetlen volt. Best-effort, hiba esetén 0.
 */
export async function evaluatePending(
  _currentPrices: Record<string, number>,
  minAgeMs = 55 * 60 * 1000,
  options: ScoreOptions = {},
): Promise<{ evaluated: number; unscored: number }> {
  const db = getDb();
  if (!db) return { evaluated: 0, unscored: 0 };
  const horizonHours = options.horizonHours ?? DEFAULT_HORIZON_HOURS;
  const toleranceHours = options.toleranceHours ?? DEFAULT_TOLERANCE_HOURS;

  try {
    const cutoff = new Date(Date.now() - minAgeMs);
    const rows = await db
      .select({ id: schema.decisions.id, ts: schema.decisions.ts, ref: schema.decisions.ref })
      .from(schema.decisions)
      .where(
        and(isNotNull(schema.decisions.ref), isNull(schema.decisions.outcome), lt(schema.decisions.ts, cutoff)),
      );
    if (rows.length === 0) return { evaluated: 0, unscored: 0 };

    // A horizont árait a NAPLÓZOTT tick-pillanatképekből vesszük, időbélyeggel együtt.
    const oldest = rows.reduce((m, r) => Math.min(m, new Date(r.ts).getTime()), Number.POSITIVE_INFINITY);
    const windowStart = new Date(oldest);
    const windowEnd = new Date(Date.now());
    const priceRows = await db
      .select({ ts: schema.decisions.ts, ref: schema.decisions.ref })
      .from(schema.decisions)
      .where(and(isNotNull(schema.decisions.ref), gte(schema.decisions.ts, windowStart), lte(schema.decisions.ts, windowEnd)))
      .orderBy(asc(schema.decisions.ts));

    const seriesBySymbol = new Map<string, PricePoint[]>();
    for (const row of priceRows) {
      const ref = row.ref as DecisionRef | null;
      if (!ref?.prices) continue;
      const ts = new Date(row.ts).getTime();
      for (const [symbol, price] of Object.entries(ref.prices)) {
        const arr = seriesBySymbol.get(symbol) ?? [];
        arr.push({ ts, price });
        seriesBySymbol.set(symbol, arr);
      }
    }

    let evaluated = 0;
    let unscored = 0;
    for (const row of rows) {
      const ref = row.ref as DecisionRef;
      const ts = new Date(row.ts).getTime();
      const series = ref.intentSymbol ? (seriesBySymbol.get(ref.intentSymbol) ?? []) : [];
      const at = priceAtHorizon(series, ts, horizonHours, toleranceHours);
      const outcome = scoreDecision(ref, at, ts, { horizonHours, toleranceHours });
      await db.update(schema.decisions).set({ outcome }).where(eq(schema.decisions.id, row.id));
      if (outcome.unscored) unscored++;
      else evaluated++;
    }
    return { evaluated, unscored };
  } catch (e) {
    console.error("[evaluate] evaluatePending hiba:", e);
    return { evaluated: 0, unscored: 0 };
  }
}

export interface PerformanceSummary {
  evaluated: number;
  actionable: number;
  /** IRÁNYTALÁLAT aránya — NEM profit, és nem is a profitmutató helyettesítője. */
  hitRate: number | null;
  /** Átlagos irány-pontszám %-ban. NEM realizált hozam. */
  avgDirectionalScorePct: number;
  /** Hány döntés maradt pontozatlanul, és miért. */
  unscored: Record<string, number>;
}

/**
 * Összesített IRÁNY-statisztika. A név szándékosan nem „profit": ez diagnosztika arról,
 * hogy az AI eltalálta-e az irányt, nem arról, hogy mennyit keresett volna.
 */
export async function getPerformanceSummary(): Promise<PerformanceSummary> {
  const db = getDb();
  const emptyResult: PerformanceSummary = {
    evaluated: 0,
    actionable: 0,
    hitRate: null,
    avgDirectionalScorePct: 0,
    unscored: {},
  };
  if (!db) return emptyResult;
  try {
    const rows = await db
      .select({ outcome: schema.decisions.outcome })
      .from(schema.decisions)
      .where(isNotNull(schema.decisions.outcome));
    const outcomes = rows.map((r) => r.outcome as DecisionOutcome);
    const unscored: Record<string, number> = {};
    for (const o of outcomes) if (o.unscored) unscored[o.unscored] = (unscored[o.unscored] ?? 0) + 1;

    const actionable = outcomes.filter((o) => !o.unscored && o.directionHit !== null);
    const wins = actionable.filter((o) => o.directionHit).length;
    const avg = actionable.length
      ? actionable.reduce((s, o) => s + o.directionalScorePct, 0) / actionable.length
      : 0;
    return {
      evaluated: outcomes.length,
      actionable: actionable.length,
      hitRate: actionable.length ? wins / actionable.length : null,
      avgDirectionalScorePct: avg,
      unscored,
    };
  } catch (e) {
    console.error("[evaluate] getPerformanceSummary hiba:", e);
    return emptyResult;
  }
}

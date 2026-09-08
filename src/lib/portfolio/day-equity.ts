/**
 * Valódi NAPI veszteségkorlát (T07).
 *
 * Az audit §4 bizonyította: a régi kód `equity / initialCapital − 1`-et számolt, ami az
 * INDULÁS ÓTA mért hozam, nem a napi. Egy régi veszteség így örökre HOLD-ba fagyaszthatta
 * a botot, egy régi nyereség pedig elrejthette az aznapi −3%-ot.
 *
 * A javítás:
 *  - UTC napkezdő equity-referencia (`daily_equity` sor) portfóliónként és módonként;
 *  - a nap közbeni pénzmozgás (be- és kifizetés) korrigálja a hozamot;
 *  - a −3% elérése LATCH-el: a nap végéig tiltja az új BUY-t akkor is, ha az equity
 *    közben visszakúszik. Ez tudatos, verziózott szigorítás;
 *  - a SELL és a meglévő védelem SOHA nem tiltott;
 *  - ha nincs hiteles referencia vagy nem mérhető az equity, NINCS kitalált napi hozam:
 *    az új BUY szünetel, amíg hiteles referencia nem áll rendelkezésre.
 *
 * A számítás tiszta függvény: injektált idő, nincs IO. A DB-réteg lent, külön.
 */
import { type Dec, ZERO, add, sub, div, lte, isPositive, toNumber } from "@/lib/portfolio/money";

export type DayBaselineSource = "day-open" | "partial-day" | "missing";

export interface DayEquityRow {
  dayUtc: string; // YYYY-MM-DD (UTC)
  baselineEquity: Dec;
  /** A nap közbeni be- és kifizetések egyenlege (pozitív = befizetés). */
  cashFlowQuote: Dec;
  source: DayBaselineSource;
  lossLatched: boolean;
  latchedAt: number | null;
}

export interface DayGateInput {
  nowMs: number;
  /** A mai (UTC) sor, ha már létezik. */
  row: DayEquityRow | null;
  /**
   * A jelenlegi teljes equity. `null`, ha NEM mérhető (pl. hiányzik egy birtokolt coin
   * ára) — ilyenkor nem találunk ki napi hozamot.
   */
  currentEquity: Dec | null;
  /** A napi veszteségkapu küszöbe pozitív törtként (0.03 = 3%). */
  thresholdPct: Dec;
  /**
   * Ennyi ideig számít egy első megfigyelés hiteles NAPNYITÁSNAK. Ezen túl az aznapi
   * első mérés csak résznapos referencia (`partial-day`), és a napi hozam is így értendő.
   */
  dayOpenToleranceMs?: number;
  /**
   * A nap AZONOSÍTÓJA. Üresen az UTC nap (kripto, 24/7). A részvény-sáv a tőzsdei ülés
   * ET-dátumát adja: ott a „nap" a kereskedési nap, nem az UTC naptári nap, különben a
   * 09:30 ET nyitás már a következő UTC napra esne a nyári időszámítás alatt.
   */
  dayKey?: string;
  /**
   * A nap KEZDETE ms-ban — ehhez méri a rendszer a napnyitás-toleranciát. Üresen az UTC
   * éjfél. A részvény-sáv az ülés nyitását (09:30 ET) adja, különben a nyitáskori első
   * mérés mindig „résznapos" referenciának látszana.
   */
  dayStartMs?: number;
}

export interface DayGateResult {
  dayUtc: string;
  row: DayEquityRow;
  /** A napi hozam törtként. `null`, ha nincs hiteles referencia. */
  dayPnlPct: number | null;
  latched: boolean;
  /** Igaz, ha ÚJ vétel tiltott. A SELL sosem tiltott. */
  blockNewBuys: boolean;
  reason: string;
  /** Igaz, ha a sort le kell menteni (új nap vagy latch-váltás). */
  needsPersist: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAY_OPEN_TOLERANCE_MS = 15 * 60 * 1000;

/** UTC nap kulcsa (YYYY-MM-DD). */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Az adott UTC nap kezdetének epoch ms értéke. */
export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * A napi kapu kiértékelése. Tiszta: minden bemenet injektált.
 *
 * A napi hozam a PÉNZMOZGÁSSAL KORRIGÁLT equityből számol:
 *   dayPnl = (equity − cashFlow) / baseline − 1
 * Egy 10 USD befizetés így nem látszik napi nyereségnek.
 */
export function evaluateDayGate(input: DayGateInput): DayGateResult {
  const dayUtc = input.dayKey ?? utcDayKey(input.nowMs);
  const tolerance = input.dayOpenToleranceMs ?? DEFAULT_DAY_OPEN_TOLERANCE_MS;

  // 1) Nem mérhető equity → nincs kitalált hozam, új vétel szünetel.
  if (input.currentEquity === null) {
    const row: DayEquityRow = input.row ?? {
      dayUtc,
      baselineEquity: ZERO,
      cashFlowQuote: ZERO,
      source: "missing",
      lossLatched: false,
      latchedAt: null,
    };
    return {
      dayUtc,
      row: { ...row, source: input.row ? row.source : "missing" },
      dayPnlPct: null,
      latched: row.lossLatched,
      blockNewBuys: true,
      reason: "Az equity nem mérhető (hiányzó ár) — nincs napi hozam, új vétel szünetel.",
      needsPersist: input.row === null,
    };
  }

  // 2) Új nap (vagy legelső futás): baseline felvétele.
  if (!input.row || input.row.dayUtc !== dayUtc) {
    const sinceDayStart = input.nowMs - (input.dayStartMs ?? utcDayStart(input.nowMs));
    const source: DayBaselineSource = sinceDayStart <= tolerance ? "day-open" : "partial-day";
    const row: DayEquityRow = {
      dayUtc,
      baselineEquity: input.currentEquity,
      cashFlowQuote: ZERO,
      source,
      lossLatched: false,
      latchedAt: null,
    };
    return {
      dayUtc,
      row,
      dayPnlPct: 0,
      latched: false,
      blockNewBuys: false,
      reason:
        source === "day-open"
          ? "Új kereskedési nap — napkezdő equity-referencia rögzítve."
          : "Nap közbeni indulás — RÉSZNAPOS referencia; a napi hozam ettől a ponttól értendő.",
      needsPersist: true,
    };
  }

  const row = input.row;

  // 3) Hiányzó (nem hiteles) referencia: nincs kitalált napi hozam.
  if (row.source === "missing" || !isPositive(row.baselineEquity)) {
    return {
      dayUtc,
      row,
      dayPnlPct: null,
      latched: row.lossLatched,
      blockNewBuys: true,
      reason: "Nincs hiteles napkezdő equity-referencia — új vétel szünetel.",
      needsPersist: false,
    };
  }

  // 4) Napi hozam pénzmozgás-korrekcióval.
  const adjusted = sub(input.currentEquity, row.cashFlowQuote);
  const dayPnlPct = toNumber(div(adjusted, row.baselineEquity)) - 1;
  const breached = lte(div(adjusted, row.baselineEquity), sub("1", input.thresholdPct));
  const latched = row.lossLatched || breached;

  return {
    dayUtc,
    row: latched && !row.lossLatched ? { ...row, lossLatched: true, latchedAt: input.nowMs } : row,
    dayPnlPct,
    latched,
    blockNewBuys: latched,
    reason: latched
      ? row.lossLatched
        ? "A napi veszteségkapu ma már aktiválódott (latch) — új vétel a következő UTC napig tiltott."
        : `A napi veszteség elérte a küszöböt (${(dayPnlPct * 100).toFixed(2)}%) — latch bekapcsolva.`
      : `Napi hozam ${(dayPnlPct * 100).toFixed(2)}%.`,
    needsPersist: latched && !row.lossLatched,
  };
}

/** Az INDULÁS ÓTA mért hozam — KÜLÖN mutató, nem a napi kapu bemenete. */
export function sinceInceptionPnlPct(currentEquity: Dec, initialCapital: Dec): number | null {
  if (!isPositive(initialCapital)) return null;
  return toNumber(div(currentEquity, initialCapital)) - 1;
}

/** Egy pénzmozgás hozzáadása a napi korrekcióhoz (pozitív = befizetés). */
export function withCashFlow(row: DayEquityRow, amount: Dec): DayEquityRow {
  return { ...row, cashFlowQuote: add(row.cashFlowQuote, amount) };
}

// ── DB-réteg ────────────────────────────────────────────────────────────────

import { getDb, schema, type Db } from "@/db/client";
import { and, eq } from "drizzle-orm";

/** A mai (UTC) sor betöltése. Hiba vagy hiányzó DB esetén null — nem dob. */
export async function loadDayEquityRow(
  portfolioId: string,
  mode: "paper" | "live",
  dayUtc: string,
  dbOverride?: Db | null,
): Promise<DayEquityRow | null> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return null;
  try {
    const [row] = await db
      .select()
      .from(schema.dailyEquity)
      .where(
        and(
          eq(schema.dailyEquity.portfolioId, portfolioId),
          eq(schema.dailyEquity.mode, mode),
          eq(schema.dailyEquity.dayUtc, dayUtc),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      dayUtc: row.dayUtc,
      baselineEquity: row.baselineEquity,
      cashFlowQuote: row.cashFlowQuote,
      source: row.source as DayBaselineSource,
      lossLatched: row.lossLatched,
      latchedAt: row.latchedAt ? row.latchedAt.getTime() : null,
    };
  } catch (e) {
    console.error("[day-equity] loadDayEquityRow hiba:", e);
    return null;
  }
}

/** A napi sor beszúrása/frissítése. Idempotens a (portfolio, mode, nap) kulcson. */
export async function saveDayEquityRow(
  portfolioId: string,
  mode: "paper" | "live",
  row: DayEquityRow,
  dbOverride?: Db | null,
): Promise<boolean> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return false;
  try {
    await db
      .insert(schema.dailyEquity)
      .values({
        portfolioId,
        mode,
        dayUtc: row.dayUtc,
        baselineEquity: row.baselineEquity,
        cashFlowQuote: row.cashFlowQuote,
        source: row.source,
        lossLatched: row.lossLatched,
        latchedAt: row.latchedAt ? new Date(row.latchedAt) : null,
      })
      .onConflictDoUpdate({
        target: [schema.dailyEquity.portfolioId, schema.dailyEquity.mode, schema.dailyEquity.dayUtc],
        set: {
          cashFlowQuote: row.cashFlowQuote,
          lossLatched: row.lossLatched,
          latchedAt: row.latchedAt ? new Date(row.latchedAt) : null,
        },
      });
    return true;
  } catch (e) {
    console.error("[day-equity] saveDayEquityRow hiba:", e);
    return false;
  }
}

/**
 * A napi kapu betöltése, kiértékelése és szükség esetén mentése — egy hívásban.
 * A baseline SOSEM íródik felül egy már létező napon (onConflictDoUpdate csak a
 * cash flow-t és a latchet frissíti), így két egyidejű napnyitás sem billenti el.
 */
export async function resolveDayGate(
  portfolioId: string,
  mode: "paper" | "live",
  currentEquity: Dec | null,
  thresholdPct: Dec,
  nowMs: number,
  dbOverride?: Db | null,
  /** Nap-definíció. Üresen UTC nap/éjfél (kripto); a részvény-sáv ülés-napot ad. */
  day?: { dayKey?: string; dayStartMs?: number },
): Promise<DayGateResult> {
  const dayUtc = day?.dayKey ?? utcDayKey(nowMs);
  const existing = await loadDayEquityRow(portfolioId, mode, dayUtc, dbOverride);
  const evalInput = { nowMs, currentEquity, thresholdPct, dayKey: dayUtc, dayStartMs: day?.dayStartMs };
  const result = evaluateDayGate({ ...evalInput, row: existing });
  if (result.needsPersist) {
    await saveDayEquityRow(portfolioId, mode, result.row, dbOverride);
    // Verseny esetén a másik futó baseline-ja nyert: olvassuk vissza és számoljunk azzal.
    const persisted = await loadDayEquityRow(portfolioId, mode, dayUtc, dbOverride);
    if (persisted && persisted.baselineEquity !== result.row.baselineEquity) {
      return evaluateDayGate({ ...evalInput, row: persisted });
    }
  }
  return result;
}

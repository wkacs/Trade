import { describe, it, expect } from "vitest";
import {
  evaluateDayGate,
  utcDayKey,
  utcDayStart,
  sinceInceptionPnlPct,
  withCashFlow,
  type DayEquityRow,
} from "@/lib/portfolio/day-equity";

const DAY = 24 * 60 * 60 * 1000;
/** 2026-09-05 00:00:00 UTC */
const MIDNIGHT = Date.UTC(2026, 8, 5, 0, 0, 0);
const THRESHOLD = "0.03";

const row = (over: Partial<DayEquityRow> = {}): DayEquityRow => ({
  dayUtc: "2026-09-05",
  baselineEquity: "100",
  cashFlowQuote: "0",
  source: "day-open",
  lossLatched: false,
  latchedAt: null,
  ...over,
});

describe("day-equity — UTC nap és baseline", () => {
  it("a nap kulcsa és kezdete UTC szerint értendő", () => {
    expect(utcDayKey(MIDNIGHT)).toBe("2026-09-05");
    expect(utcDayKey(MIDNIGHT + DAY - 1)).toBe("2026-09-05");
    expect(utcDayKey(MIDNIGHT + DAY)).toBe("2026-09-06");
    expect(utcDayStart(MIDNIGHT + 5 * 3600_000)).toBe(MIDNIGHT);
  });

  it("az első futás éjfél közelében HITELES napnyitás", () => {
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 5 * 60_000, row: null, currentEquity: "100", thresholdPct: THRESHOLD });
    expect(r.row.source).toBe("day-open");
    expect(r.row.baselineEquity).toBe("100");
    expect(r.dayPnlPct).toBe(0);
    expect(r.needsPersist).toBe(true);
    expect(r.blockNewBuys).toBe(false);
  });

  it("a nap közbeni indulás RÉSZNAPOS referencia, nem teljes napi hozam", () => {
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 9 * 3600_000, row: null, currentEquity: "100", thresholdPct: THRESHOLD });
    expect(r.row.source).toBe("partial-day");
    expect(r.reason).toMatch(/RÉSZNAPOS/);
    expect(r.blockNewBuys).toBe(false);
  });

  it("napváltáskor ÚJ baseline készül, a régi latch nem öröklődik", () => {
    const yesterday = row({ dayUtc: "2026-09-04", lossLatched: true, latchedAt: MIDNIGHT - 3600_000 });
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 60_000, row: yesterday, currentEquity: "90", thresholdPct: THRESHOLD });
    expect(r.dayUtc).toBe("2026-09-05");
    expect(r.row.baselineEquity).toBe("90");
    expect(r.latched).toBe(false);
    expect(r.blockNewBuys).toBe(false);
  });
});

describe("day-equity — napi hozam és latch", () => {
  it("a napi hozam a napkezdő equityhez mérve számol, nem a kezdőtőkéhez", () => {
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 3600_000, row: row(), currentEquity: "97", thresholdPct: THRESHOLD });
    expect(r.dayPnlPct).toBeCloseTo(-0.03, 12);
    expect(r.latched).toBe(true);
  });

  it("-2,9% még nem kapcsolja be a latchet", () => {
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 3600_000, row: row(), currentEquity: "97.1", thresholdPct: THRESHOLD });
    expect(r.latched).toBe(false);
    expect(r.blockNewBuys).toBe(false);
  });

  it("a latch a nap végéig tart, akkor is, ha az equity visszakúszik", () => {
    const latched = row({ lossLatched: true, latchedAt: MIDNIGHT + 3600_000 });
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 7200_000, row: latched, currentEquity: "105", thresholdPct: THRESHOLD });
    expect(r.dayPnlPct).toBeCloseTo(0.05, 12);
    expect(r.latched).toBe(true);
    expect(r.blockNewBuys).toBe(true);
  });

  it("az előző napi nyereség NEM rejti el az aznapi -3%-ot", () => {
    // A tegnapi zárás 200-ra vitte az equityt; a mai baseline 200.
    const today = row({ baselineEquity: "200" });
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 3600_000, row: today, currentEquity: "193", thresholdPct: THRESHOLD });
    expect(r.dayPnlPct).toBeCloseTo(-0.035, 12);
    expect(r.latched).toBe(true);
  });

  it("a nap közbeni befizetés nem látszik napi nyereségnek", () => {
    const withDeposit = withCashFlow(row(), "10");
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 3600_000, row: withDeposit, currentEquity: "110", thresholdPct: THRESHOLD });
    expect(r.dayPnlPct).toBeCloseTo(0, 12);
  });

  it("a nap közbeni kifizetés nem látszik napi veszteségnek", () => {
    const withdrawal = withCashFlow(row(), "-10");
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 3600_000, row: withdrawal, currentEquity: "90", thresholdPct: THRESHOLD });
    expect(r.dayPnlPct).toBeCloseTo(0, 12);
    expect(r.latched).toBe(false);
  });

  it("a latch csak az ÚJ vételt tiltja — az eladás soha nem tiltott", () => {
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 3600_000, row: row(), currentEquity: "50", thresholdPct: THRESHOLD });
    expect(r.blockNewBuys).toBe(true);
    // A DayGateResult nem tartalmaz SELL-tiltást: a kapu csak a BUY-ra vonatkozik.
    expect(Object.keys(r)).not.toContain("blockSells");
  });
});

describe("day-equity — hiányzó referencia és nem mérhető equity", () => {
  it("nem mérhető equity: nincs kitalált napi hozam, új vétel szünetel", () => {
    const r = evaluateDayGate({ nowMs: MIDNIGHT + 3600_000, row: row(), currentEquity: null, thresholdPct: THRESHOLD });
    expect(r.dayPnlPct).toBeNull();
    expect(r.blockNewBuys).toBe(true);
    expect(r.reason).toMatch(/nem mérhető/i);
  });

  it("missing forrású sor: nincs napi hozam, új vétel szünetel", () => {
    const r = evaluateDayGate({
      nowMs: MIDNIGHT + 3600_000,
      row: row({ source: "missing", baselineEquity: "0" }),
      currentEquity: "100",
      thresholdPct: THRESHOLD,
    });
    expect(r.dayPnlPct).toBeNull();
    expect(r.blockNewBuys).toBe(true);
  });

  it("nulla baseline nem oszt nullával, hanem hiányzó referenciának számít", () => {
    const r = evaluateDayGate({
      nowMs: MIDNIGHT + 3600_000,
      row: row({ baselineEquity: "0" }),
      currentEquity: "100",
      thresholdPct: THRESHOLD,
    });
    expect(r.dayPnlPct).toBeNull();
  });
});

describe("day-equity — az indulás óta mért hozam KÜLÖN mutató", () => {
  it("nem keveredik a napi hozammal", () => {
    expect(sinceInceptionPnlPct("59", "100")).toBeCloseTo(-0.41, 12);
    expect(sinceInceptionPnlPct("150", "100")).toBeCloseTo(0.5, 12);
  });

  it("nulla kezdőtőkére null (nincs kitalált szám)", () => {
    expect(sinceInceptionPnlPct("100", "0")).toBeNull();
  });
});

// ── Saját nap-definíció (a részvény-sáv ülés-napja, nem UTC nap) ─────────────────

describe("evaluateDayGate – injektált nap-definíció", () => {
  const THRESHOLD = "0.03";
  // 2026-02-02 09:35 ET — 5 perccel az ülés nyitása (14:30Z) után, de 14,5 órával
  // az UTC éjfél után.
  const NOW = Date.parse("2026-02-02T14:35:00Z");
  const SESSION_OPEN = Date.parse("2026-02-02T14:30:00Z");

  it("UTC nap szerint ez már RÉSZNAPOS referencia", () => {
    const res = evaluateDayGate({ nowMs: NOW, row: null, currentEquity: "10000", thresholdPct: THRESHOLD });
    expect(res.row.source).toBe("partial-day");
  });

  it("ülés-nyitáshoz mérve viszont hiteles NAPNYITÁS", () => {
    const res = evaluateDayGate({
      nowMs: NOW,
      row: null,
      currentEquity: "10000",
      thresholdPct: THRESHOLD,
      dayStartMs: SESSION_OPEN,
    });
    expect(res.row.source).toBe("day-open");
  });

  it("a megadott nap-kulcsot használja a sor azonosításához", () => {
    const res = evaluateDayGate({
      nowMs: NOW,
      row: null,
      currentEquity: "10000",
      thresholdPct: THRESHOLD,
      dayKey: "2026-02-02-et",
    });
    expect(res.dayUtc).toBe("2026-02-02-et");
    expect(res.row.dayUtc).toBe("2026-02-02-et");
  });

  it("a saját kulcsú mai sorral tovább számol (nem vesz fel új baseline-t)", () => {
    const row = {
      dayUtc: "2026-02-02-et",
      baselineEquity: "10000",
      cashFlowQuote: "0",
      source: "day-open" as const,
      lossLatched: false,
      latchedAt: null,
    };
    const res = evaluateDayGate({
      nowMs: NOW,
      row,
      currentEquity: "9600", // −4% → küszöb alatt
      thresholdPct: THRESHOLD,
      dayKey: "2026-02-02-et",
    });
    expect(res.latched).toBe(true);
    expect(res.blockNewBuys).toBe(true);
  });
});

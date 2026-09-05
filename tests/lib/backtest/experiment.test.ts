import { describe, it, expect } from "vitest";
import {
  summarize,
  tradeUncertainty,
  sufficiency,
  compareRuns,
  compareEntries,
  exitCadenceStudy,
  reportHash,
  formatReport,
  formatRow,
  frameSpacingMinutes,
  type ExperimentReport,
  type VariantRow,
} from "@/lib/backtest/experiment";
import type { BacktestResult, EntryEvent, HistoryFrame, RealizationEvent } from "@/lib/backtest/types";

const H = 3_600_000;

function realization(pnlUsd: number, costBasisUsd = 100, over: Partial<RealizationEvent> = {}): RealizationEvent {
  return {
    ts: 0,
    symbol: "BTC",
    qty: 1,
    exitPrice: 100,
    pnlUsd,
    costBasisUsd,
    feeUsd: 0.1,
    closesPosition: true,
    kind: "market",
    ...over,
  };
}

function entry(ts: number, over: Partial<EntryEvent> = {}): EntryEvent {
  return { ts, symbol: "BTC", qty: 1, fillPrice: 100, amountUsd: 100, feeUsd: 0.1, kind: "dca", ...over };
}

function result(over: Partial<BacktestResult> = {}): BacktestResult {
  const base: BacktestResult = {
    metrics: {
      totalReturnPct: 0.1,
      sharpe: 1,
      maxDrawdownPct: 0.05,
      hitRate: 0.6,
      tradesCount: 2,
      avgWinPct: 0.1,
      avgLossPct: -0.05,
      profitFactor: 2,
      profitFactorInfinite: false,
      exposurePct: 0.4,
      totalFeesUsd: 1,
      samplingHours: 1,
    },
    equityCurve: [
      { ts: 0, equityUsd: 100 },
      { ts: H, equityUsd: 110 },
    ],
    closedTrades: [{ symbol: "BTC", entryPrice: 100, exitPrice: 110, qty: 1, pnlUsd: 10, pnlPct: 0.1 }],
    realizations: [realization(10)],
    entries: [entry(0)],
    config: { symbols: ["BTC"], initialCapitalUsd: 100, feePct: 0.001, slippageBps: 5 },
    from: 0,
    to: H,
    rejections: {},
  };
  return { ...base, ...over };
}

describe("egy futás összefoglalása", () => {
  it("a nettó hozam a ZÁRÓ equityből jön, nem a metrikából", () => {
    const s = summarize(result());
    expect(s.netReturnPct).toBeCloseTo(0.1, 10);
    expect(s.finalEquityUsd).toBe(110);
  });

  it("a forgalom a vétel ÉS az eladás összege", () => {
    const s = summarize(
      result({
        entries: [entry(0), entry(H, { amountUsd: 50 })],
        realizations: [realization(10, 100, { qty: 1, exitPrice: 110 })],
      }),
    );
    // 100 + 50 vétel + 110 eladás = 260, ami az induló 100 USD 2.6-szorosa.
    expect(s.turnoverUsd).toBe(260);
    expect(s.turnoverRatio).toBeCloseTo(2.6, 10);
  });

  it("a költség a ZÁRÓ tőke arányában értendő (a keret is így van megadva)", () => {
    const s = summarize(result());
    expect(s.costPct).toBeCloseTo(1 / 110, 10);
  });
});

describe("bizonytalanság", () => {
  it("egyetlen kötésből NINCS becslés", () => {
    expect(tradeUncertainty([realization(10)])).toBeNull();
    expect(tradeUncertainty([])).toBeNull();
  });

  it("a konfidencia-intervallum a kötésenkénti szórásból származik", () => {
    const u = tradeUncertainty([realization(10), realization(-10), realization(20), realization(0)])!;
    expect(u.n).toBe(4);
    expect(u.meanPct).toBeCloseTo(0.05, 10); // (0.1 - 0.1 + 0.2 + 0) / 4
    expect(u.ci95[0]).toBeLessThan(u.meanPct);
    expect(u.ci95[1]).toBeGreaterThan(u.meanPct);
  });

  it("a nulla bekerülésű realizálás kimarad (nem osztunk nullával)", () => {
    const u = tradeUncertainty([realization(10), realization(-10), realization(5, 0)]);
    expect(u!.n).toBe(2);
  });
});

describe("eldönthetőség", () => {
  const s = summarize(result());

  it("kevés kötés → NEM ELDÖNTHETŐ (nem bukás)", () => {
    const r = sufficiency(s, { minClosedTrades: 30, bars: 5000, minBars: 100 });
    expect(r.status).toBe("insufficient_sample");
    expect(r.reason).toMatch(/nem eldönthető/);
  });

  it("kevés adat KÜLÖN eset a kevés kötéstől", () => {
    const r = sufficiency(s, { minClosedTrades: 1, bars: 50, minBars: 100 });
    expect(r.status).toBe("insufficient_data");
    expect(r.reason).toMatch(/gyertya/);
  });

  it("elég adat és elég kötés mellett eldönthető", () => {
    const r = sufficiency({ ...s, closedTrades: 40 }, { minClosedTrades: 30, bars: 5000, minBars: 100 });
    expect(r).toEqual({ status: "decidable", reason: null });
  });
});

describe("összehasonlítás", () => {
  const mk = (ret: number, rets: number[]) => ({
    summary: { ...summarize(result()), netReturnPct: ret },
    uncertainty: tradeUncertainty(rets.map((r) => realization(r * 100))),
  });

  it("ÁTFEDŐ intervallumnál a különbség nem különböztethető meg a zajtól", () => {
    const c = compareRuns(mk(0.1, [0.1, -0.1, 0.2, 0]), mk(0.13, [0.12, -0.08, 0.18, 0.02]));
    expect(c.deltaReturnPct).toBeCloseTo(0.03, 10);
    expect(c.intervalsOverlap).toBe(true);
    expect(c.statement).toMatch(/ÁTFEDNEK/);
  });

  it("nem átfedő intervallumnál ezt is kimondja", () => {
    const c = compareRuns(mk(0.02, [0.01, 0.011, 0.009, 0.01]), mk(0.5, [0.5, 0.51, 0.49, 0.5]));
    expect(c.intervalsOverlap).toBe(false);
    expect(c.statement).toMatch(/NEM fednek át/);
  });

  it("becslés nélkül nem állítunk semmit az eltérésről", () => {
    const c = compareRuns(mk(0.1, [0.1]), mk(0.3, [0.3]));
    expect(c.intervalsOverlap).toBeNull();
    expect(c.statement).toMatch(/nem értelmezhető/);
  });
});

describe("kilépési ütem — a belépéseknek AZONOSNAK kell lenniük", () => {
  it("az azonos belépés-sorozatot felismeri", () => {
    const d = compareEntries([entry(0), entry(H)], [entry(0), entry(H)]);
    expect(d.identical).toBe(true);
  });

  it("az eltérő belépést KIMONDJA (különben az összehasonlítás érvénytelen)", () => {
    const d = compareEntries([entry(0), entry(H)], [entry(0), entry(2 * H)]);
    expect(d.identical).toBe(false);
    expect(d.firstDifference).toMatch(/2\. belépés eltér/);
  });

  it("az eltérő darabszám is eltérés", () => {
    const d = compareEntries([entry(0)], [entry(0), entry(H)]);
    expect(d.identical).toBe(false);
    expect(d.firstDifference).toMatch(/Eltérő belépés-szám: 1 vs 2/);
  });

  it("órás adaton a 60 percnél sűrűbb kilépés NEM MÉRHETŐ, nem közelítjük", () => {
    const outcomes = exitCadenceStudy([1, 5, 15, 60], 60, () => result());
    expect(outcomes.slice(0, 3).map((o) => o.status)).toEqual([
      "insufficient_resolution",
      "insufficient_resolution",
      "insufficient_resolution",
    ]);
    expect(outcomes[0].reason).toMatch(/60 perces felbontású/);
    expect(outcomes[3].status).toBe("measured");
  });

  it("finomabb adaton a sűrűbb ütem mérhető, és a belépés-egyezés ellenőrzött", () => {
    const outcomes = exitCadenceStudy([5, 15], 5, () => result());
    expect(outcomes.every((o) => o.status === "measured")).toBe(true);
    expect(outcomes[0].entryDiff).toBeNull(); // ez a referencia
    expect(outcomes[1].entryDiff!.identical).toBe(true);
  });

  it("ha a belépések eltérnek, a jelentés figyelmeztet", () => {
    let call = 0;
    const outcomes = exitCadenceStudy([5, 15], 5, () =>
      call++ === 0 ? result() : result({ entries: [entry(2 * H)] }),
    );
    expect(outcomes[1].entryDiff!.identical).toBe(false);
    const report = baseReport({ cadences: outcomes });
    expect(formatReport(report)).toMatch(/a belépések ELTÉRNEK/);
  });
});

function row(over: Partial<VariantRow> = {}): VariantRow {
  const s = summarize(result());
  return {
    experimentId: "E1",
    variantId: "baseline",
    label: "alapvonal",
    raisesRisk: false,
    scenario: { costId: "base", capitalId: "small", executionModel: "polling" },
    summary: s,
    uncertainty: tradeUncertainty([realization(10), realization(-5), realization(8)]),
    sufficiency: { status: "decidable", reason: null },
    comparison: null,
    ...over,
  };
}

function baseReport(over: Partial<ExperimentReport> = {}): ExperimentReport {
  return {
    protocolVersion: "exp-v1",
    protocolHash: "aaaaaaaa",
    strategyVersion: "v2",
    developmentDataHash: "dddddddd",
    holdoutDataHash: "hhhhhhhh",
    bars: { development: 4000, holdout: 1000 },
    rows: [row()],
    controls: [row({ experimentId: "control", variantId: "buy-and-hold" })],
    cadences: [],
    openQuestions: [],
    generatedFrom: { frames: 5000, from: 0, to: H },
    ...over,
  };
}

describe("jelentés", () => {
  it("két azonos bemenetű futás AZONOS hash-t ad", () => {
    expect(reportHash(baseReport())).toBe(reportHash(baseReport()));
  });

  it("egyetlen szám megváltozása is más hash-t ad", () => {
    const a = baseReport();
    const b = baseReport({ rows: [row({ summary: { ...summarize(result()), netReturnPct: 0.11 } })] });
    expect(reportHash(a)).not.toBe(reportHash(b));
  });

  it("a nem eldönthető sor NEM kap hozam-értelmezést", () => {
    const text = formatRow(
      row({ sufficiency: { status: "insufficient_sample", reason: "7 lezárt kötés, a küszöb 30." } }),
    );
    expect(text).toMatch(/⚠ 7 lezárt kötés/);
    expect(text).not.toMatch(/átlag/);
  });

  it("a gyenge variánsok is bent maradnak a jelentésben", () => {
    const weak = row({ variantId: "fg30", summary: { ...summarize(result()), netReturnPct: -0.4 } });
    const text = formatReport(baseReport({ rows: [row(), weak] }));
    expect(text).toContain("fg30");
    expect(text).toContain("-40.00%");
  });

  it("a fejléc hordozza a protokoll- és adat-hash-t (reprodukálhatóság)", () => {
    const text = formatReport(baseReport());
    expect(text).toContain("hash aaaaaaaa");
    expect(text).toContain("dddddddd");
    expect(text).toContain("hhhhhhhh");
    expect(text).toContain(reportHash(baseReport()));
  });

  it("a nyitva maradt kérdések külön szekcióban látszanak", () => {
    const text = formatReport(baseReport({ openQuestions: ["Az AI-ág nem visszajátszható 2026-07 előtt."] }));
    expect(text).toMatch(/## Nyitva maradt kérdések/);
    expect(text).toMatch(/nem visszajátszható/);
  });
});

describe("felbontás", () => {
  const frames = (n: number, stepMs: number): HistoryFrame[] =>
    Array.from({ length: n }, (_, i) => ({ ts: i * stepMs, candles: {}, fearGreedValue: null }));

  it("a gyertyaköz percben számolódik", () => {
    expect(frameSpacingMinutes(frames(3, H))).toBe(60);
    expect(frameSpacingMinutes(frames(3, 5 * 60_000))).toBe(5);
  });

  it("egyetlen gyertyából órás felbontást feltételezünk (konzervatív)", () => {
    expect(frameSpacingMinutes(frames(1, H))).toBe(60);
  });
});

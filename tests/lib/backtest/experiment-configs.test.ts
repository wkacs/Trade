import { describe, it, expect } from "vitest";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import {
  EXPERIMENTS,
  FROZEN_BUDGET,
  FROZEN_WINDOW,
  COST_SCENARIOS,
  CAPITAL_SCENARIOS,
  EXIT_CADENCES_MIN,
  evaluateAcceptance,
  isRiskier,
  strategyDiff,
  validateExperiment,
  validateProtocol,
  protocolHash,
  describeProtocol,
  type AcceptanceInput,
} from "../../../scripts/experiment-configs";

/**
 * T29 — a protokoll a mérés ELŐTT fagy be.
 *
 * Az audit §8 megállapítása: a régi tournament a teszt-ablakon választott, és a
 * küszöböt utólag igazította a látott eredményhez. Az itteni tesztek azt őrzik, hogy
 * ez ne legyen újra megtehető észrevétlenül.
 */
describe("kísérleti változatok — egy kísérlet EGY kérdés", () => {
  it("minden kísérlet érvényes: a változatok csak a saját tengelyükön térnek el", () => {
    expect(validateProtocol()).toEqual([]);
  });

  it("minden kísérletben a baseline PONTOSAN a futó éles stratégia", () => {
    for (const exp of EXPERIMENTS) {
      const baseline = exp.variants.find((v) => v.id === "baseline");
      expect(baseline, exp.id).toBeDefined();
      expect(strategyDiff(baseline!.strategy, DEFAULT_STRATEGY)).toEqual([]);
    }
  });

  it("a tengelyen kívüli eltérést a validáció ELKAPJA", () => {
    const broken = {
      id: "E-broken",
      question: "?",
      axis: ["takeProfitPct"] as const,
      variants: [
        { id: "baseline", label: "b", strategy: DEFAULT_STRATEGY, raisesRisk: false, note: "" },
        {
          id: "sneaky",
          label: "s",
          // A kérdés a take-profit, de közben a pozícióméret is nő — ez a klasszikus
          // „nem tudjuk, mitől lett jobb" hiba.
          strategy: { ...DEFAULT_STRATEGY, takeProfitPct: 0.2, maxPositionPct: 0.4 },
          raisesRisk: true,
          note: "",
        },
      ],
    };
    const issues = validateExperiment(broken as never);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/tengelyen KÍVÜL/);
    expect(issues[0].message).toMatch(/maxPositionPct/);
  });

  it("a hibás raisesRisk jelölést is elkapja", () => {
    const mislabeled = {
      id: "E-mislabeled",
      question: "?",
      axis: ["maxPositionPct"] as const,
      variants: [
        { id: "baseline", label: "b", strategy: DEFAULT_STRATEGY, raisesRisk: false, note: "" },
        {
          id: "bigger",
          label: "40%",
          strategy: { ...DEFAULT_STRATEGY, maxPositionPct: 0.4 },
          raisesRisk: false, // HAZUG jelölés
          note: "",
        },
      ],
    };
    const issues = validateExperiment(mislabeled as never);
    expect(issues.some((i) => i.message.includes("raisesRisk"))).toBe(true);
  });

  it("a jelenlegi kísérletek EGYIKE SEM emel kockázatot", () => {
    const risky = EXPERIMENTS.flatMap((e) => e.variants.filter((v) => v.raisesRisk).map((v) => `${e.id}/${v.id}`));
    expect(risky).toEqual([]);
  });

  it("az isRiskier a lazítást ismeri fel, a szigorítást nem", () => {
    expect(isRiskier({ ...DEFAULT_STRATEGY, maxPositionPct: 0.3 }, DEFAULT_STRATEGY)).toBe(true);
    expect(isRiskier({ ...DEFAULT_STRATEGY, stopLossPct: 0.1 }, DEFAULT_STRATEGY)).toBe(true);
    expect(isRiskier({ ...DEFAULT_STRATEGY, maxConcurrentPositions: 5 }, DEFAULT_STRATEGY)).toBe(true);
    expect(isRiskier({ ...DEFAULT_STRATEGY, maxPositionPct: 0.1 }, DEFAULT_STRATEGY)).toBe(false);
    expect(isRiskier({ ...DEFAULT_STRATEGY, takeProfitPct: 0.2 }, DEFAULT_STRATEGY)).toBe(false);
  });
});

describe("elfogadási szabály — előre rögzített küszöbök", () => {
  const good: AcceptanceInput = {
    netReturnPct: 0.18,
    maxDrawdownPct: 0.12,
    exposurePct: 0.5,
    closedTrades: 40,
    totalFeesUsd: 1.5,
    finalEquityUsd: 118,
    baselineReturnPct: 0.1,
  };

  it("minden keret teljesülésekor és elég többletnél elfogadható", () => {
    const r = evaluateAcceptance(good);
    expect(r.verdict).toBe("accept");
    expect(r.protocolVersion).toBe("exp-v1-2026-09-05");
  });

  it("kevés kötésnél NEM ELDÖNTHETŐ — nem siker és nem bukás", () => {
    const r = evaluateAcceptance({ ...good, closedTrades: 7 });
    expect(r.verdict).toBe("undecided");
    expect(r.reasons[0]).toMatch(/nem elég a döntéshez/);
  });

  it("a keretet sértő lehúzás ELUTASÍT, bármilyen magas hozam mellett", () => {
    const r = evaluateAcceptance({ ...good, netReturnPct: 5, maxDrawdownPct: 0.6 });
    expect(r.verdict).toBe("reject");
    expect(r.reasons.join(" ")).toMatch(/lehúzás/);
  });

  it("a költségkeret túllépése önmagában is elutasít", () => {
    // 10 USD díj 118 USD záró tőkére = 8.5%, a keret 3%.
    const r = evaluateAcceptance({ ...good, totalFeesUsd: 10 });
    expect(r.verdict).toBe("reject");
    expect(r.reasons.join(" ")).toMatch(/költség/);
  });

  it("a vak alapvonalat épp csak meghaladó eredmény NEM elég", () => {
    const r = evaluateAcceptance({ ...good, netReturnPct: 0.105, baselineReturnPct: 0.1 });
    expect(r.verdict).toBe("reject");
    expect(r.reasons.join(" ")).toMatch(/alapvonalhoz képest/);
  });

  it("a keretsértés a hozam ELŐTT dönt (sorrend számít)", () => {
    const r = evaluateAcceptance({ ...good, maxDrawdownPct: 0.9, exposurePct: 0.99 });
    expect(r.verdict).toBe("reject");
    // Mindkét keretsértés megjelenik, nem csak az első.
    expect(r.reasons).toHaveLength(2);
  });
});

describe("a protokoll ujjlenyomata", () => {
  it("determinisztikus: ugyanaz a protokoll ugyanaz a hash", () => {
    expect(protocolHash()).toBe(protocolHash());
    expect(protocolHash()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("a leírás minden fagyasztott döntést tartalmaz", () => {
    const text = describeProtocol();
    expect(text).toContain(protocolHash());
    expect(text).toMatch(/max lehúzás 25%/);
    expect(text).toMatch(/holdout 20% \(EGYSZERI mérés\)/);
    for (const exp of EXPERIMENTS) expect(text).toContain(exp.id);
  });

  it("a fagyasztott keret értékei a dokumentált értékek", () => {
    // Ha ezek változnak, az ÚJ protokoll — a régi jelentések nem hasonlíthatók hozzá.
    expect(FROZEN_BUDGET).toEqual({
      maxDrawdownPct: 0.25,
      maxCostBudgetPct: 0.03,
      maxExposurePct: 0.9,
      minClosedTrades: 30,
      minEdgeOverBaselinePct: 0.02,
    });
    expect(FROZEN_WINDOW.holdoutRatio).toBe(0.2);
    expect(COST_SCENARIOS.map((c) => c.id)).toEqual(["base", "elevated"]);
    expect(CAPITAL_SCENARIOS.map((c) => c.initialCapitalUsd)).toEqual([100, 10_000]);
    expect([...EXIT_CADENCES_MIN]).toEqual([1, 5, 15, 60]);
  });
});

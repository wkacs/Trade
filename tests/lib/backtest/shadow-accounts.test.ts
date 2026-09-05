import { describe, it, expect } from "vitest";
import {
  defineShadowSet,
  validateShadowSet,
  crossAccountGuard,
  ledgerBelongsTo,
  shadowPortfolioId,
  shadowProgress,
  summarizeIncidents,
  compareShadowAccounts,
  SHADOW_TARGET,
  type ShadowAccount,
  type ShadowAccountStats,
} from "@/lib/backtest/shadow-accounts";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import type { RunSummary, Uncertainty } from "@/lib/backtest/experiment";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 5, 0, 0, 0);

const set = () =>
  defineShadowSet(
    { id: "baseline", label: "javított alapvonal", strategy: DEFAULT_STRATEGY },
    [
      { id: "atr2", label: "ATR × 2", strategy: { ...DEFAULT_STRATEGY, stopMode: "atr", atrMult: 2 } },
      { id: "ai", label: "alapvonal + AI", strategy: DEFAULT_STRATEGY, aiEnabled: true },
    ],
    { startingCapitalUsd: 100 },
  );

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  initialCapitalUsd: 100,
  finalEquityUsd: 105,
  netReturnPct: 0.05,
  maxDrawdownPct: 0.03,
  exposurePct: 0.5,
  closedTrades: 60,
  realizationCount: 70,
  totalFeesUsd: 1.2,
  costPct: 0.011,
  turnoverUsd: 300,
  turnoverRatio: 3,
  rejections: {},
  ...over,
});

const unc = (mean: number, se: number): Uncertainty => ({
  n: 60,
  meanPct: mean,
  stdDevPct: se * Math.sqrt(60),
  standardErrorPct: se,
  ci95: [mean - 1.96 * se, mean + 1.96 * se],
});

const stats = (account: ShadowAccount, over: Partial<ShadowAccountStats> = {}): ShadowAccountStats => ({
  account,
  summary: summary(),
  uncertainty: unc(0.01, 0.002),
  cycles: 720,
  incidents: 0,
  ...over,
});

describe("árnyékkészlet felépítése", () => {
  it("minden számla SAJÁT portfolioId-t kap, és mind paper", () => {
    const accounts = set();
    expect(accounts.map((a) => a.portfolioId)).toEqual(["shadow:baseline", "shadow:atr2", "shadow:ai"]);
    expect(accounts.every((a) => a.mode === "paper")).toBe(true);
    expect(new Set(accounts.map((a) => a.portfolioId)).size).toBe(3);
  });

  it("az induló tőke minden számlán AZONOS", () => {
    expect(new Set(set().map((a) => a.startingCapitalUsd))).toEqual(new Set([100]));
  });

  it("pontosan egy alapvonal van", () => {
    expect(set().filter((a) => a.isBaseline).map((a) => a.id)).toEqual(["baseline"]);
  });

  it("az érvényes készlet nem ad hibát", () => {
    expect(validateShadowSet(set())).toEqual([]);
  });
});

describe("készlet-érvényesség", () => {
  it("ÉLES számla nem lehet a készletben", () => {
    const accounts = set();
    accounts[1] = { ...accounts[1], mode: "live" };
    const issues = validateShadowSet(accounts);
    expect(issues.some((i) => i.message.includes("ÉLES számla nem lehet"))).toBe(true);
  });

  it("két számla nem oszthat portfolioId-t", () => {
    const accounts = set();
    accounts[1] = { ...accounts[1], portfolioId: accounts[0].portfolioId };
    expect(validateShadowSet(accounts).some((i) => i.message.includes("ugyanazt a portfolioId-t"))).toBe(true);
  });

  it("eltérő induló tőke ELRONTJA az összehasonlítást, ezért hiba", () => {
    const accounts = set();
    accounts[1] = { ...accounts[1], startingCapitalUsd: 10_000 };
    expect(validateShadowSet(accounts).some((i) => i.message.includes("Eltérő induló tőke"))).toBe(true);
  });

  it("egyetlen számla nem összevetés", () => {
    expect(validateShadowSet([set()[0]]).some((i) => i.message.includes("Legalább két számla"))).toBe(true);
  });

  it("két alapvonal is hiba", () => {
    const accounts = set();
    accounts[1] = { ...accounts[1], isBaseline: true };
    expect(validateShadowSet(accounts).some((i) => i.message.includes("Pontosan egy alapvonal"))).toBe(true);
  });
});

describe("számla-izoláció", () => {
  it("idegen számlára szóló intent NEM hajtható végre", () => {
    const [baseline, atr2] = set();
    const g = crossAccountGuard({ portfolioId: baseline.portfolioId, mode: "paper" }, atr2);
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/shadow:baseline/);
  });

  it("a saját intent átmegy", () => {
    const [baseline] = set();
    expect(crossAccountGuard({ portfolioId: baseline.portfolioId, mode: "paper" }, baseline).ok).toBe(true);
  });

  it("LIVE intent árnyékszámlán TILOS", () => {
    const [baseline] = set();
    const g = crossAccountGuard({ portfolioId: baseline.portfolioId, mode: "live" }, baseline);
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/csak paper/);
  });

  it("a betöltött ledger hovatartozása ellenőrizhető", () => {
    const [baseline, atr2] = set();
    expect(ledgerBelongsTo({ portfolioId: "shadow:baseline", mode: "paper" }, baseline)).toBe(true);
    expect(ledgerBelongsTo({ portfolioId: "shadow:baseline", mode: "paper" }, atr2)).toBe(false);
    expect(ledgerBelongsTo({ portfolioId: "shadow:atr2", mode: "live" }, atr2)).toBe(false);
  });

  it("a portfolioId névtere elkülöníti az éles paper számlától", () => {
    expect(shadowPortfolioId("baseline")).toBe("shadow:baseline");
    expect(shadowPortfolioId("baseline", "exp2")).toBe("exp2:baseline");
  });
});

describe("megfigyelési előrehaladás", () => {
  it("a cél mindkét feltétele kell: idő ÉS körforduló", () => {
    expect(shadowProgress(T0, T0 + 40 * DAY, 20).complete).toBe(false);
    expect(shadowProgress(T0, T0 + 10 * DAY, 80).complete).toBe(false);
    expect(shadowProgress(T0, T0 + 40 * DAY, 80).complete).toBe(true);
  });

  it("a nyitott megfigyelés kimondja, mennyi hiányzik", () => {
    const p = shadowProgress(T0, T0 + 10 * DAY, 12);
    expect(p.message).toMatch(/10\.0\/30 nap/);
    expect(p.message).toMatch(/12\/50 lezárt körforduló/);
    expect(p.message).toMatch(/Verdikt még nem adható/);
  });

  it("a teljesült cél sem statisztikai garancia, és ezt ki is mondja", () => {
    expect(shadowProgress(T0, T0 + 40 * DAY, 80).message).toMatch(/sem statisztikai garancia/);
  });

  it("a rögzített cél 30 nap és 50 körforduló", () => {
    expect(SHADOW_TARGET).toEqual({ minDays: 30, minRoundTrips: 50 });
  });
});

describe("összevetés", () => {
  const accounts = set();
  const done = shadowProgress(T0, T0 + 40 * DAY, 80);

  it("a cél teljesüléséig a verdikt NYITOTT, akkor is, ha nagy az eltérés", () => {
    const open = shadowProgress(T0, T0 + 3 * DAY, 5);
    const c = compareShadowAccounts(
      stats(accounts[0]),
      stats(accounts[1], { summary: summary({ netReturnPct: 0.9 }) }),
      open,
    );
    expect(c.verdict).toBe("open");
    expect(c.deltaNetReturnPct).toBeCloseTo(0.85, 10);
  });

  it("eltérő ciklusszámnál az eltérés NEM a stratégiának tulajdonítható", () => {
    const c = compareShadowAccounts(stats(accounts[0]), stats(accounts[1], { cycles: 300 }), done);
    expect(c.verdict).toBe("open");
    expect(c.cycleMismatch).toBe(true);
    expect(c.statement).toMatch(/nem a stratégiának tulajdonítható/);
  });

  it("átfedő intervallumnál nincs kimutatható különbség", () => {
    const c = compareShadowAccounts(
      stats(accounts[0]),
      stats(accounts[1], { summary: summary({ netReturnPct: 0.06 }), uncertainty: unc(0.011, 0.002) }),
      done,
    );
    expect(c.verdict).toBe("no_difference");
    expect(c.statement).toMatch(/nem kimutatható/);
  });

  it("nem átfedő intervallumnál megnevezi a jobbat, de nem ígér jövőt", () => {
    const c = compareShadowAccounts(
      stats(accounts[0]),
      stats(accounts[1], { summary: summary({ netReturnPct: 0.2 }), uncertainty: unc(0.05, 0.002) }),
      done,
    );
    expect(c.verdict).toBe("candidate_better");
    expect(c.statement).toMatch(/sem garancia a jövőre/);
  });

  it("a rosszabb jelöltet is kimondja", () => {
    const c = compareShadowAccounts(
      stats(accounts[0]),
      stats(accounts[1], { summary: summary({ netReturnPct: -0.1 }), uncertainty: unc(-0.03, 0.002) }),
      done,
    );
    expect(c.verdict).toBe("baseline_better");
  });

  it("becslés nélkül nincs verdikt", () => {
    const c = compareShadowAccounts(stats(accounts[0]), stats(accounts[1], { uncertainty: null }), done);
    expect(c.verdict).toBe("open");
  });
});

describe("incidensek", () => {
  it("az incidens nélküli futás is jelentendő", () => {
    expect(summarizeIncidents([]).note).toMatch(/Nem volt rögzített incidens/);
  });

  it("az incidensek fajtánként számolódnak, és az eredmény értelmezését módosítják", () => {
    const s = summarizeIncidents([
      { ts: T0, accountId: "baseline", kind: "missing_tick", detail: "" },
      { ts: T0, accountId: "atr2", kind: "missing_tick", detail: "" },
      { ts: T0, accountId: null, kind: "data_gap", detail: "" },
    ]);
    expect(s.total).toBe(3);
    expect(s.byKind).toEqual({ missing_tick: 2, data_gap: 1 });
    expect(s.note).toMatch(/a kimaradt ciklus torzít/);
  });
});

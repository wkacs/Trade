import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketPanel } from "@/components/MarketPanel";
import { DecisionCard, type DecisionRow } from "@/components/DecisionCard";
import { ShadowPanel, ShadowLaneRow, type ShadowLaneView } from "@/components/ShadowPanel";
import type { PerformanceSummary, DecisionOutcome } from "@/lib/portfolio/evaluate";

/**
 * Szerződés-tesztek: a dashboard komponensei PONTOSAN azokat a mezőket olvassák,
 * amiket a backend ad. A T20 átnevezés (hypotheticalPnlPct → directionalScorePct,
 * wouldProfit → directionHit) után az UI a régi neveken maradt, és a `.toFixed()`
 * egy undefined-on client-side exception-t dobott az egész oldalra.
 */
describe("MarketPanel — PerformanceSummary szerződés", () => {
  it("kirajzolja az irány-pontszámot a backend mezőnevéből", () => {
    const performance: PerformanceSummary = {
      evaluated: 12,
      actionable: 8,
      hitRate: 0.625,
      avgDirectionalScorePct: 1.234,
      unscored: { stale_horizon: 4 },
    };
    const html = renderToStaticMarkup(
      createElement(MarketPanel, { signals: [], mlAuc: null, performance }),
    );
    expect(html).toContain("1.23%");
    expect(html).toContain("63%");
  });

  it("nem omlik össze, ha még nincs pontozható döntés", () => {
    const performance: PerformanceSummary = {
      evaluated: 0,
      actionable: 0,
      hitRate: null,
      avgDirectionalScorePct: 0,
      unscored: {},
    };
    const html = renderToStaticMarkup(
      createElement(MarketPanel, { signals: [], mlAuc: null, performance }),
    );
    expect(html).toContain("—");
  });
});

describe("DecisionCard — DecisionOutcome szerződés", () => {
  const base: DecisionRow = {
    id: "d1",
    ts: "2026-09-06T08:00:00.000Z",
    action: "BUY",
    symbol: "BTC",
    amountPct: 0.1,
    confidence: 0.7,
    reasoning: "teszt",
    overridden: false,
    overrideReason: null,
  };

  it("irány-találatot mutat a directionHit / directionalScorePct mezőkből", () => {
    const outcome: DecisionOutcome = {
      horizonHours: 1,
      horizonErrorHours: 0.1,
      refSymbol: "BTC",
      changePct: 2.5,
      directionalScorePct: 2.5,
      directionHit: true,
    };
    const html = renderToStaticMarkup(
      createElement(DecisionCard, { d: { ...base, outcome } }),
    );
    expect(html).toContain("2.50%");
    expect(html).toContain("eltalálta az irányt");
  });

  it("HOLD-nál (directionHit null) semlegeset ír, nem dob", () => {
    const outcome: DecisionOutcome = {
      horizonHours: 1,
      horizonErrorHours: 0,
      refSymbol: "BTC",
      changePct: -1.5,
      directionalScorePct: 0,
      directionHit: null,
    };
    const html = renderToStaticMarkup(
      createElement(DecisionCard, { d: { ...base, action: "HOLD", outcome } }),
    );
    expect(html).toContain("semleges");
    expect(html).toContain("-1.50%");
  });

  it("pontozatlan döntésnél az okot mutatja, nem számot", () => {
    const outcome: DecisionOutcome = {
      horizonHours: 1,
      horizonErrorHours: 9,
      refSymbol: "BTC",
      changePct: 0,
      directionalScorePct: 0,
      directionHit: null,
      unscored: "stale_horizon",
    };
    const html = renderToStaticMarkup(
      createElement(DecisionCard, { d: { ...base, outcome } }),
    );
    expect(html).toContain("nem pontozható");
  });

  it("régi formátumú (T20 előtti) outcome-on sem dob kivételt", () => {
    const legacy = {
      horizonHours: 1,
      refSymbol: "BTC",
      changePct: 1,
      hypotheticalPnlPct: 1,
      wouldProfit: true,
    } as unknown as DecisionOutcome;
    expect(() =>
      renderToStaticMarkup(createElement(DecisionCard, { d: { ...base, outcome: legacy } })),
    ).not.toThrow();
  });
});

describe("ShadowPanel — az árnyék-mérés szerződése", () => {
  const lane = (over: Partial<ShadowLaneView> = {}): ShadowLaneView => ({
    namespace: "shadow-teszt",
    candidateId: "L2",
    note: "teszt-jelölt",
    capitalUsd: 320,
    startedAt: "2026-09-06",
    targetDays: 30,
    targetRoundTrips: 50,
    rows: [
      { accountId: "baseline", cycles: 5, days: 1, equity: 320, netReturnPct: 0, maxDrawdownPct: 0, roundTrips: 0, feesQuote: 0, degradedCycles: 0 },
      { accountId: "L2", cycles: 5, days: 1, equity: 336, netReturnPct: 0.05, maxDrawdownPct: 0.01, roundTrips: 3, feesQuote: 0.4, degradedCycles: 0 },
    ],
    error: null,
    ...over,
  });

  it("a jelölt és az alapvonal különbségét is kiírja", () => {
    const html = renderToStaticMarkup(createElement(ShadowPanel));
    expect(html).toContain("Árnyék-mérés");
    // A panel a szerverre kérdez; a sor-renderelést külön, tiszta bemenettel nézzük.
    const laneHtml = renderToStaticMarkup(createElement(ShadowLaneRow, { lane: lane() }));
    expect(laneHtml).toContain("+5.00%");
    expect(laneHtml).toContain("$336.00");
    expect(laneHtml).toContain("3 kör");
  });

  it("ciklus nélkül nem hazudik nullát, hanem kimondja", () => {
    const html = renderToStaticMarkup(createElement(ShadowLaneRow, { lane: lane({ rows: [] }) }));
    expect(html).toContain("még nincs ciklus");
  });

  it("olvasási hibát láthatóan jelez", () => {
    const html = renderToStaticMarkup(
      createElement(ShadowLaneRow, { lane: lane({ rows: [], error: "nincs provisionált mérés" }) }),
    );
    expect(html).toContain("nem olvasható");
  });
});

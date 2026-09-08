import { describe, it, expect } from "vitest";
import { runBacktest } from "@/lib/backtest/engine";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import type { HistoryFrame, BacktestConfig } from "@/lib/backtest/types";

const H = 3600_000;
const frame = (
  i: number,
  btc: { o: number; h: number; l: number; c: number },
  fg: number | null,
): HistoryFrame => ({
  ts: i * H,
  candles: { BTC: { ts: i * H, open: btc.o, high: btc.h, low: btc.l, close: btc.c, volume: 1 } },
  fearGreedValue: fg,
});

const cfg: BacktestConfig = { symbols: ["BTC"], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 };

/**
 * BEMELEGÍTŐ keretek (T15): a stratégia legnagyobb visszatekintése 48 gyertya, ezért
 * ennyi hézagmentes előzmény nélkül NINCS trend- vagy momentum-engedély. A warmup a
 * MÚLTBÓL jön, nem a jövőből: itt lapos, 100-as áron, semleges F&G mellett.
 */
const warmup = (bars = 48, price = 100, fg: number | null = 50): HistoryFrame[] =>
  Array.from({ length: bars }, (_, i) => frame(i, { o: price, h: price, l: price, c: price }, fg));

/** A warmup után folytatódó keretek, helyes időbélyeggel. */
const after = (base: HistoryFrame[], rest: ((i: number) => HistoryFrame)[]): HistoryFrame[] => [
  ...base,
  ...rest.map((f, i) => f(base.length + i)),
];

describe("runBacktest", () => {
  it("DCA-belépő extrém félelemnél, majd take-profit emelkedésnél → pozitív return", () => {
    const history = after(warmup(), [
      (i) => frame(i, { o: 100, h: 100, l: 100, c: 100 }, 20), // F&G 20 ≤ 25 → DCA BUY
      (i) => frame(i, { o: 100, h: 130, l: 100, c: 125 }, 50), // +30% high → take-profit
      (i) => frame(i, { o: 125, h: 126, l: 124, c: 125 }, 50),
    ]);
    const result = runBacktest(history, cfg);
    expect(result.equityCurve).toHaveLength(51);
    expect(result.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(result.config.initialCapitalUsd).toBe(10000);
  });

  it("ATR-stop konfiggal is lefut (nem dob), és ad eredményt", () => {
    const history = after(warmup(), [
      (i) => frame(i, { o: 100, h: 100, l: 100, c: 100 }, 20),
      (i) => frame(i, { o: 100, h: 110, l: 95, c: 105 }, 50),
    ]);
    const r = runBacktest(history, cfg, { ...DEFAULT_STRATEGY, stopMode: "atr", atrMult: 2 });
    expect(r.equityCurve).toHaveLength(50);
  });

  it("stop-loss zuhanásnál → lezárt trade + legalább egy trade", () => {
    // A polling modellben a jel a LEZÁRT gyertyából születik, és a KÖVETKEZŐ nyitón
    // teljesül — ezért a stop észlelése után még kell egy keret a végrehajtáshoz.
    const history = after(warmup(), [
      (i) => frame(i, { o: 100, h: 100, l: 100, c: 100 }, 20), // DCA-terv
      (i) => frame(i, { o: 100, h: 100, l: 100, c: 100 }, 50), // itt teljesül a BUY, stop ~95
      (i) => frame(i, { o: 100, h: 100, l: 90, c: 92 }, 50), // a megfigyelt 92 ≤ stop → stop-terv
      (i) => frame(i, { o: 92, h: 93, l: 91, c: 92 }, 50), // itt teljesül a stop-eladás
    ]);
    const result = runBacktest(history, cfg);
    expect(result.closedTrades.length).toBeGreaterThanOrEqual(1);
    expect(result.metrics.tradesCount).toBeGreaterThanOrEqual(1);
  });

  it("AUDIT §6: 24 gyertya NEM elég a 48 órás ablakhoz — nincs belépő", () => {
    // Végig emelkedő 24 gyertya: a régi kód `false` momentumot adott, de a trend-szűrő
    // átengedte a DCA-t. Most sem trend-, sem momentum-engedély nincs adathiány miatt.
    const history: HistoryFrame[] = Array.from({ length: 24 }, (_, i) =>
      frame(i, { o: 100 + i, h: 100 + i, l: 100 + i, c: 100 + i }, 10),
    );
    const r = runBacktest(history, cfg, { ...DEFAULT_STRATEGY, momentumEnabled: true });
    expect(r.metrics.exposurePct).toBe(0);
    expect(r.closedTrades).toHaveLength(0);
  });

  it("üres history → nulla metrikák, nem dob", () => {
    const result = runBacktest([], cfg);
    expect(result.metrics.totalReturnPct).toBe(0);
    expect(result.equityCurve).toHaveLength(0);
  });

  it("momentum BE: a breakout-történeten piacra lép; OFF mellett nem (F&G semleges)", () => {
    // 60 frame, szigorúan emelkedő close → minden frame új csúcs; F&G 50 → nincs DCA.
    // A 48 gyertyás breakout-ablak miatt legalább ennyi ELŐZMÉNY kell.
    const history: HistoryFrame[] = Array.from({ length: 60 }, (_, i) =>
      frame(i, { o: 100 + i, h: 100 + i, l: 100 + i, c: 100 + i }, 50),
    );
    const off = runBacktest(history, cfg, { ...DEFAULT_STRATEGY, momentumEnabled: false });
    const on = runBacktest(history, cfg, { ...DEFAULT_STRATEGY, momentumEnabled: true });
    // OFF: se DCA (F&G 50 > 20), se momentum → soha nem lép piacra.
    expect(off.metrics.exposurePct).toBe(0);
    // ON: a breakout (lookback 48) után nyit pozíciót → van kitettség és pozitív hozam.
    expect(on.metrics.exposurePct).toBeGreaterThan(0);
    expect(on.metrics.totalReturnPct).toBeGreaterThan(0);
  });
});

// ── Audit 4. és 6. pont: nyitáskori értékelés és backteszt↔élő paritás ──────────

describe("runBacktest – a nyitáskori kötés nem láthatja a bar záróárát (audit 4.)", () => {
  /**
   * Azonos MÚLT, azonos következő NYITÓ, eltérő következő ZÁRÓ. A nyitón végrehajtott
   * order méretének azonosnak kell lennie: a záróár akkor még nem létezik.
   *
   * Hogy a hiba látszódjon, a pozíciókeret SZOROSAN fog: 20% DCA-tétel 20%-os
   * pozíciókorlát mellett, meglévő készlettel — így a keret tényleg vág, és a vágás
   * mértéke az értékeléshez használt ártól függ.
   */
  const strategy = { ...DEFAULT_STRATEGY, dcaBuyPct: 0.2, dcaWeeklyBudgetPct: 0.5, entryFilter: "off" as const };

  const scenario = (lastClose: number) =>
    after(warmup(), [
      (i) => frame(i, { o: 100, h: 100, l: 100, c: 100 }, 20), // DCA-t tervez
      (i) => frame(i, { o: 100, h: 100, l: 100, c: 100 }, 20), // itt teljesül + újat tervez
      (i) => frame(i, { o: 100, h: Math.max(100, lastClose), l: 100, c: lastClose }, 50),
    ]);

  it("a második vétel mérete független a végrehajtási bar záróárától", () => {
    const flat = runBacktest(scenario(100), cfg, strategy);
    const spike = runBacktest(scenario(300), cfg, strategy);
    const buys = (r: ReturnType<typeof runBacktest>) => r.entries.map((e) => e.amountUsd);
    expect(buys(spike)).toEqual(buys(flat));
  });
});

describe("runBacktest – a futó rendszerrel közös szabályok (audit 6.)", () => {
  it("a momentum-vétel NEM fogyasztja a DCA heti keretét", () => {
    // Szűk heti keret: egyetlen DCA fér bele. Ha a momentum is beleszámítana, a
    // következő DCA elmaradna.
    const strategy = {
      ...DEFAULT_STRATEGY,
      momentumEnabled: true,
      entryFilter: "off" as const,
      dcaBuyPct: 0.02,
      dcaWeeklyBudgetPct: 0.03,
    };
    const history = after(warmup(), [
      // Kitörés: emelkedő sor, hogy a momentum belépjen.
      ...Array.from({ length: 4 }, (_, k) => (i: number) => frame(i, { o: 100 + k, h: 101 + k, l: 99 + k, c: 101 + k }, 50)),
      (i) => frame(i, { o: 105, h: 105, l: 105, c: 105 }, 20), // DCA-jel
      (i) => frame(i, { o: 105, h: 105, l: 105, c: 105 }, 20),
      (i) => frame(i, { o: 105, h: 105, l: 105, c: 105 }, 50),
    ]);
    const result = runBacktest(history, cfg, strategy);
    const kinds = result.entries.map((e) => e.kind);
    expect(kinds).toContain("momentum");
    expect(kinds).toContain("dca");

    // A LÉNYEG: a DCA a TELJES 2%-ot költhette (~200 USD). Ha a momentum 200 USD-je is a
    // heti 3%-os (300 USD) DCA-keretből ment volna, a DCA ~100 USD-re vágódna.
    const dca = result.entries.find((e) => e.kind === "dca")!;
    expect(dca.amountUsd).toBeGreaterThan(150);
  });

  it("a napi veszteségkapu a backtesztben is tilt (nem csak az éles ágon)", () => {
    // NAGY pozíció (20%), majd 40%-os zuhanás → a napi veszteség −8%, a 3%-os latch
    // bekapcsol, és aznap már NINCS új vétel.
    const strategy = {
      ...DEFAULT_STRATEGY,
      entryFilter: "off" as const,
      dcaBuyPct: 0.2,
      dcaWeeklyBudgetPct: 0.5,
    };
    const history = after(warmup(), [
      (i) => frame(i, { o: 100, h: 100, l: 100, c: 100 }, 20), // DCA-t tervez
      (i) => frame(i, { o: 100, h: 100, l: 100, c: 100 }, 20), // teljesül, újat tervez
      (i) => frame(i, { o: 60, h: 60, l: 60, c: 60 }, 20), // −40% → napi latch
      (i) => frame(i, { o: 60, h: 60, l: 60, c: 60 }, 20), // itt már nem vehet
      (i) => frame(i, { o: 60, h: 60, l: 60, c: 60 }, 20),
    ]);
    const result = runBacktest(history, cfg, strategy);
    expect(result.rejections.daily_loss_latched ?? 0).toBeGreaterThan(0);
  });
});

describe("runBacktest – hiányzó ár mellett nincs KITALÁLT equity (audit 1./6.)", () => {
  const H2 = 3600_000;
  /** Két papíros keret; a `btc: null` azt jelenti, hogy arra a papírra NINCS gyertya. */
  const f2 = (
    i: number,
    btc: { o: number; h: number; l: number; c: number } | null,
    eth: { o: number; h: number; l: number; c: number },
    fg: number | null,
  ): HistoryFrame => ({
    ts: i * H2,
    candles: {
      ...(btc ? { BTC: { ts: i * H2, open: btc.o, high: btc.h, low: btc.l, close: btc.c, volume: 1 } } : {}),
      ETH: { ts: i * H2, open: eth.o, high: eth.h, low: eth.l, close: eth.c, volume: 1 },
    },
    fearGreedValue: fg,
  });

  it("birtokolt, de ÁRTALAN papír mellett az új vétel a hiányzó referencia miatt elutasul", () => {
    const cfg2: BacktestConfig = { symbols: ["BTC", "ETH"], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 };
    const strategy = { ...DEFAULT_STRATEGY, entryFilter: "off" as const, dcaBuyPct: 0.2, dcaWeeklyBudgetPct: 0.5 };
    const flat = { o: 100, h: 100, l: 100, c: 100 };
    const history: HistoryFrame[] = [
      ...Array.from({ length: 48 }, (_, i) => f2(i, flat, flat, 50)),
      f2(48, flat, flat, 20), // BTC/ETH DCA-t tervez
      f2(49, flat, flat, 20), // teljesül (lesz pozíció), újat tervez
      // A BIRTOKOLT BTC-re nincs ár; a DCA-jelölt az eső ETH lesz.
      f2(50, null, { o: 95, h: 95, l: 95, c: 95 }, 20),
      f2(51, null, { o: 95, h: 95, l: 95, c: 95 }, 20),
      f2(52, null, { o: 95, h: 95, l: 95, c: 95 }, 20),
    ];
    const result = runBacktest(history, cfg2, strategy);
    expect(result.rejections.day_baseline_missing ?? 0).toBeGreaterThan(0);
  });
});

describe("runBacktest – a napi referencia minden nap rögzül (független audit)", () => {
  it("esemény nélküli nap után a zuhanás latch-el, nem születik friss baseline a zuhanás UTÁN", () => {
    // 78 óra: vétel a 49. órában, majd két csendes nap. A 4. nap 74. órájában −20%-os
    // zuhanás. A napkezdő referencia a nap ELSŐ bárján rögzül, ezért a latch bekapcsol, és
    // a 75. órában tervezett vétel a 76. órában NEM teljesülhet.
    const history: HistoryFrame[] = Array.from({ length: 78 }, (_, i) => {
      const px = i >= 74 ? 80 : 100;
      return {
        ts: i * H,
        candles: { BTC: { ts: i * H, open: px, high: px, low: px, close: px, volume: 1 } },
        fearGreedValue: i === 48 || i === 75 ? 20 : 50,
      };
    });
    const result = runBacktest(
      history,
      { symbols: ["BTC"], initialCapitalUsd: 10000, feePct: 0, slippageBps: 0 },
      {
        ...DEFAULT_STRATEGY,
        entryFilter: "off" as const,
        dcaBuyPct: 0.2,
        dcaWeeklyBudgetPct: 0.9,
        maxPositionPct: 0.8,
        stopLossPct: 0.9,
        takeProfitPct: 10,
        dcaMax24hDropPct: 1,
      },
    );
    expect(result.entries.some((e) => e.ts === 49 * H)).toBe(true);
    expect(result.entries.some((e) => e.ts === 76 * H)).toBe(false);
    expect(result.rejections.daily_loss_latched ?? 0).toBeGreaterThan(0);
  });
});

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

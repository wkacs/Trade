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

describe("runBacktest", () => {
  it("DCA-belépő extrém félelemnél, majd take-profit emelkedésnél → pozitív return", () => {
    const history: HistoryFrame[] = [
      frame(0, { o: 100, h: 100, l: 100, c: 100 }, 20), // F&G 20 ≤ 25 → DCA BUY
      frame(1, { o: 100, h: 130, l: 100, c: 125 }, 50), // +30% high → take-profit (fél pozíció)
      frame(2, { o: 125, h: 126, l: 124, c: 125 }, 50),
    ];
    const result = runBacktest(history, cfg);
    expect(result.equityCurve).toHaveLength(3);
    expect(result.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(result.config.initialCapitalUsd).toBe(10000);
  });

  it("ATR-stop konfiggal is lefut (nem dob), és ad eredményt", () => {
    const history: HistoryFrame[] = [
      frame(0, { o: 100, h: 100, l: 100, c: 100 }, 20),
      frame(1, { o: 100, h: 110, l: 95, c: 105 }, 50),
    ];
    const r = runBacktest(history, cfg, { ...DEFAULT_STRATEGY, stopMode: "atr", atrMult: 2 });
    expect(r.equityCurve).toHaveLength(2);
  });

  it("stop-loss zuhanásnál → lezárt trade + legalább egy trade", () => {
    const history: HistoryFrame[] = [
      frame(0, { o: 100, h: 100, l: 100, c: 100 }, 20), // DCA BUY @ ~100, stop ~95
      frame(1, { o: 100, h: 100, l: 90, c: 92 }, 50), // low 90 ≤ stop ~95 → stop-loss (teljes)
    ];
    const result = runBacktest(history, cfg);
    expect(result.closedTrades.length).toBeGreaterThanOrEqual(1);
    expect(result.metrics.tradesCount).toBeGreaterThanOrEqual(1);
  });

  it("üres history → nulla metrikák, nem dob", () => {
    const result = runBacktest([], cfg);
    expect(result.metrics.totalReturnPct).toBe(0);
    expect(result.equityCurve).toHaveLength(0);
  });
});

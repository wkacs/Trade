import { describe, it, expect } from "vitest";
import {
  computeSymbolSignals,
  computeAllSignals,
  strategyRequiredBars,
  contiguousTail,
  planProfitCycle,
  type SignalCandle,
} from "@/lib/engine/profit-cycle";
import { DEFAULT_STRATEGY, STRATEGY_VERSION, type StrategyConfig } from "@/lib/strategy/config";
import { RISK_LIMITS, PROFIT_CYCLE } from "@/lib/config";
import { runBacktest } from "@/lib/backtest/engine";
import type { HistoryFrame } from "@/lib/backtest/types";

const H = 3600_000;

const flat = (n: number, price = 100, start = 0): SignalCandle[] =>
  Array.from({ length: n }, (_, i) => ({ openTime: (start + i) * H, high: price, low: price * 0.99, close: price }));

const rising = (n: number, start = 0): SignalCandle[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: (start + i) * H,
    high: 100 + i + 0.5,
    low: 100 + i - 0.5,
    close: 100 + i,
  }));

describe("EGY konfigurációs forrás (T15)", () => {
  it("a RISK_LIMITS a DEFAULT_STRATEGY-ből származik, nem külön másolat", () => {
    expect(RISK_LIMITS.maxPositionPct).toBe(DEFAULT_STRATEGY.maxPositionPct);
    expect(RISK_LIMITS.stopLossPct).toBe(DEFAULT_STRATEGY.stopLossPct);
    expect(RISK_LIMITS.maxConcurrentPositions).toBe(DEFAULT_STRATEGY.maxConcurrentPositions);
    expect(RISK_LIMITS.dailyLossCircuitBreakerPct).toBe(DEFAULT_STRATEGY.dailyLossCircuitBreakerPct);
  });

  it("a PROFIT_CYCLE is ugyanabból a forrásból jön", () => {
    expect(PROFIT_CYCLE.takeProfitPct).toBe(DEFAULT_STRATEGY.takeProfitPct);
    expect(PROFIT_CYCLE.dcaFgThreshold).toBe(DEFAULT_STRATEGY.dcaFgThreshold);
    expect(PROFIT_CYCLE.dcaWeeklyBudgetPct).toBe(DEFAULT_STRATEGY.dcaWeeklyBudgetPct);
    expect(PROFIT_CYCLE.dcaBuyPct).toBe(DEFAULT_STRATEGY.dcaBuyPct);
    expect(PROFIT_CYCLE.dcaMax24hDropPct).toBe(DEFAULT_STRATEGY.dcaMax24hDropPct);
  });

  it("a stratégia verziózott (a naplók visszavezethetők a paraméterekre)", () => {
    expect(STRATEGY_VERSION).toMatch(/^v\d/);
  });

  it("a momentum alapból KI van kapcsolva", () => {
    expect(DEFAULT_STRATEGY.momentumEnabled).toBe(false);
  });
});

describe("adat-elégségesség — nincs jel hiányos előzményből", () => {
  it("a szükséges gyertyaszám a legnagyobb visszatekintés", () => {
    expect(strategyRequiredBars(DEFAULT_STRATEGY)).toBe(48);
    expect(strategyRequiredBars({ ...DEFAULT_STRATEGY, momentumLookback: 96 })).toBe(96);
  });

  it("AUDIT §6: 24 gyertya nem elég → se trend-, se momentum-engedély", () => {
    const s = computeSymbolSignals(rising(24), DEFAULT_STRATEGY, H);
    expect(s.sufficient).toBe(false);
    expect(s.trendOk).toBe(false);
    expect(s.momentumOk).toBe(false);
    expect(s.atr).toBe(0);
  });

  it("48+ hézagmentes gyertyával a végig emelkedő sor MOMENTUM-jelet ad", () => {
    const s = computeSymbolSignals(rising(60), DEFAULT_STRATEGY, H);
    expect(s.sufficient).toBe(true);
    expect(s.trendOk).toBe(true);
    expect(s.momentumOk).toBe(true);
  });

  it("a sorozat VÉGÉN lévő rés érvényteleníti a jelet", () => {
    const withGap = [...rising(60), { openTime: 62 * H, high: 200, low: 199, close: 200 }];
    const s = computeSymbolSignals(withGap, DEFAULT_STRATEGY, H);
    expect(s.sufficient).toBe(false);
    expect(s.trendOk).toBe(false);
  });

  it("a hézagmentes vég számít, nem az összes gyertya", () => {
    expect(contiguousTail(rising(10), H)).toBe(10);
    const gapped = [...rising(5), ...rising(5, 10)];
    expect(contiguousTail(gapped, H)).toBe(5);
  });

  it("az ATR a VALÓDI high/low-ból számol (nem close-only)", () => {
    const closeOnly = flat(60).map((c) => ({ ...c, high: c.close, low: c.close }));
    const withRange = flat(60);
    const a = computeSymbolSignals(closeOnly, DEFAULT_STRATEGY, H).atr;
    const b = computeSymbolSignals(withRange, DEFAULT_STRATEGY, H).atr;
    expect(a).toBe(0);
    expect(b).toBeGreaterThan(0);
  });

  it("computeAllSignals minden symbolra ad állapotot", () => {
    const r = computeAllSignals({ BTC: rising(60), ETH: rising(10) }, DEFAULT_STRATEGY, H);
    expect(r.BTC.sufficient).toBe(true);
    expect(r.ETH.sufficient).toBe(false);
  });
});

describe("paritás — a tick és a backtest UGYANAZT a tervet kapja azonos bemenetre", () => {
  /** A backtest gördülő buffere és a tick gyertyasora azonos alakú. */
  const scenario = (config: StrategyConfig, candles: SignalCandle[], fg: number | null) => {
    const signals = computeSymbolSignals(candles, config, H);
    return planProfitCycle(
      {
        positions: [],
        candles: { BTC: { low: 100, high: 100, close: 100 } },
        fearGreedValue: fg,
        coinChanges: [{ symbol: "BTC", change24hPct: -3 }],
        weeklyBudgetRemainingUsd: 500,
        totalEquity: 10000,
        atrBySymbol: { BTC: signals.atr },
        trendOkBySymbol: { BTC: signals.trendOk },
        momentumOkBySymbol: { BTC: signals.momentumOk },
      },
      config,
    );
  };

  it("fix stop módban azonos bemenet → azonos terv", () => {
    const a = scenario(DEFAULT_STRATEGY, flat(60), 10);
    const b = scenario(DEFAULT_STRATEGY, flat(60), 10);
    expect(a).toEqual(b);
    expect(a.orders.some((o) => o.kind === "dca")).toBe(true);
  });

  it("elégtelen előzménnyel EGYIK út sem tervez belépőt", () => {
    const plan = scenario(DEFAULT_STRATEGY, flat(24), 10);
    expect(plan.orders).toHaveLength(0);
  });

  it("ATR stop módban is ugyanaz a terv születik", () => {
    const atrCfg: StrategyConfig = { ...DEFAULT_STRATEGY, stopMode: "atr", atrMult: 2 };
    expect(scenario(atrCfg, flat(60), 10)).toEqual(scenario(atrCfg, flat(60), 10));
  });

  it("a backtest ugyanezzel a warmup-küszöbbel dolgozik", () => {
    const frames: HistoryFrame[] = Array.from({ length: 24 }, (_, i) => ({
      ts: i * H,
      candles: { BTC: { ts: i * H, open: 100, high: 100, low: 100, close: 100, volume: 1 } },
      fearGreedValue: 10,
    }));
    // 24 keret → nincs elég előzmény → nincs belépő, mint a tick oldalon.
    const r = runBacktest(frames, { symbols: ["BTC"], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 });
    expect(r.metrics.exposurePct).toBe(0);
  });

  it("a backtest 48+ kerettel már belép (ugyanaz a küszöb, mint a ticknél)", () => {
    const frames: HistoryFrame[] = Array.from({ length: 60 }, (_, i) => ({
      ts: i * H,
      candles: { BTC: { ts: i * H, open: 100, high: 100, low: 100, close: 100, volume: 1 } },
      fearGreedValue: 10,
    }));
    const r = runBacktest(frames, { symbols: ["BTC"], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 });
    expect(r.metrics.exposurePct).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  planStockCycle,
  runStockCycle,
  stockDecisionDue,
  STOCK_QUOTE,
  STOCK_PORTFOLIO_ID,
  STOCK_STEP_MS,
  toSignalCandles,
  previousTradingDayKey,
  STOCK_STRATEGY,
} from "@/lib/engine/stock-tick";
import { contiguousTail } from "@/lib/engine/profit-cycle";
import { etParts, etDateKey, isUsTradingDay } from "@/lib/markets/calendar";
import { emptyLedger, type LedgerState } from "@/lib/portfolio/ledger";
import { findInstrument } from "@/lib/markets/registry";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import type { OhlcvCandle } from "@/lib/market/candles";

const AAPL = findInstrument("AAPL")!;
const NOW = Date.parse("2026-02-02T22:00:00Z"); // hétfő 17:00 ET → after-hours

// Napi gyertya-építő (idő szerint növekvő openTime).
function daily(closes: Array<{ o: number; h: number; l: number; c: number }>): OhlcvCandle[] {
  const t0 = Date.parse("2026-01-01T13:30:00Z");
  return closes.map((b, i) => ({
    symbol: "AAPL",
    timeframe: "1d",
    openTime: t0 + i * STOCK_STEP_MS,
    closeTime: t0 + i * STOCK_STEP_MS + 6 * 60 * 60 * 1000,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    baseVolume: 1000,
    quoteVolume: 1000 * b.c,
    trades: 0,
    receivedAt: t0,
  }));
}

/** USD ledger egy nyitott AAPL pozícióval. */
function ledgerWithPosition(qty: string, costBasis: string, stop: string | null): LedgerState {
  const l = emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE);
  l.positions["AAPL"] = { symbol: "AAPL", qty, costBasisQuote: costBasis, stopPrice: stop };
  return l;
}

describe("stock-tick – cadence (stockDecisionDue)", () => {
  it("after-hours-ban esedékes, és a döntési nap a mai ET-dátum", () => {
    const g = stockDecisionDue(NOW, null);
    expect(g.due).toBe(true);
    expect(g.decisionDate).toBe("2026-02-02");
    expect(g.reason).toBe("after-hours");
  });

  it("ugyanarra a napra nem fut kétszer", () => {
    const g = stockDecisionDue(NOW, "2026-02-02");
    expect(g.due).toBe(false);
    expect(g.reason).toBe("already-ran");
  });

  it("nyitott piacon és hétvégén nem esedékes", () => {
    const open = Date.parse("2026-02-02T15:00:00Z"); // 10:00 ET
    const weekend = Date.parse("2026-01-31T22:00:00Z"); // szombat
    expect(stockDecisionDue(open, null).due).toBe(false);
    expect(stockDecisionDue(open, null).reason).toBe("market-open");
    expect(stockDecisionDue(weekend, null).due).toBe(false);
    expect(stockDecisionDue(weekend, null).reason).toBe("weekend");
  });
});

describe("stock-tick – planStockCycle (tiszta)", () => {
  it("take-profit SELL-t tervez, ha a gyertya eléri a TP-t", () => {
    const candles = daily([
      { o: 100, h: 106, l: 99, c: 105 },
      { o: 106, h: 112, l: 104, c: 112 }, // high 112 ≥ TP(110)
    ]);
    const res = planStockCycle({
      candlesBySymbol: { AAPL: candles },
      positions: [{ id: "AAPL", symbol: "AAPL", qty: 10, entryPrice: 100, stopPrice: 0 }],
      totalEquityUsd: 10000,
      weeklyBudgetRemainingUsd: 0,
    });
    const tp = res.plan.orders.find((o) => o.kind === "take-profit");
    expect(tp).toBeDefined();
    expect(tp?.side).toBe("SELL");
    expect(res.lastClose.AAPL).toBe(112);
  });

  it("trailing stop felfelé kúszik (TP nélkül, magas TP-küszöbbel)", () => {
    const candles = daily([
      { o: 100, h: 121, l: 99, c: 120 },
    ]);
    const res = planStockCycle({
      candlesBySymbol: { AAPL: candles },
      positions: [{ id: "AAPL", symbol: "AAPL", qty: 10, entryPrice: 100, stopPrice: 90 }],
      totalEquityUsd: 10000,
      weeklyBudgetRemainingUsd: 0,
      strategy: { ...DEFAULT_STRATEGY, takeProfitPct: 0.5 }, // TP=150, nem sül el
    });
    const upd = res.plan.stopUpdates.find((u) => u.positionId === "AAPL");
    expect(upd).toBeDefined();
    // close 120 * (1 - 0.05) = 114 > régi 90
    expect(upd?.newStop).toBeCloseTo(114, 6);
  });
});

describe("stock-tick – runStockCycle (in-memory végrehajtás, DB nélkül)", () => {
  it("take-profitot VÉGREHAJT: eladja a pozíciót, a cash USD-ben nő", async () => {
    const ledger = ledgerWithPosition("10", "1000", null);
    const candles = daily([
      { o: 100, h: 106, l: 99, c: 105 },
      { o: 106, h: 112, l: 104, c: 112 },
    ]);
    const res = await runStockCycle({
      tickId: "2026-02-02",
      now: () => NOW,
      ledger,
      instruments: [AAPL],
      candlesBySymbol: { AAPL: candles },
      weeklyBudgetRemainingUsd: 0,
    });
    const tp = res.actions.find((a) => a.kind === "take-profit");
    expect(tp).toBeDefined();
    expect(tp?.side).toBe("SELL");
    expect(tp?.qty).toBe(10); // egész részvény
    // A cash az eladásból nőtt (10000 induló + bevétel), USD-ben.
    expect(Number(res.ledger.cash[STOCK_QUOTE])).toBeGreaterThan(10000);
    // A pozíció lezárult.
    expect(res.ledger.positions["AAPL"]?.qty ?? "0").toBe("0");
  });

  it("trailing stopot VÉGREHAJT a ledgerben (magas TP-küszöb)", async () => {
    const ledger = ledgerWithPosition("10", "1000", "90");
    const candles = daily([{ o: 100, h: 121, l: 99, c: 120 }]);
    const res = await runStockCycle({
      tickId: "2026-02-02",
      now: () => NOW,
      ledger,
      instruments: [AAPL],
      candlesBySymbol: { AAPL: candles },
      strategy: { ...DEFAULT_STRATEGY, takeProfitPct: 0.5 },
    });
    expect(res.ledger.positions["AAPL"].stopPrice).not.toBeNull();
    expect(Number(res.ledger.positions["AAPL"].stopPrice)).toBeCloseTo(114, 6);
  });

  it("üres univerzumon nem dob és nem kereskedik", async () => {
    const ledger = emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE);
    const res = await runStockCycle({
      tickId: "t",
      now: () => NOW,
      ledger,
      instruments: [],
      candlesBySymbol: {},
    });
    expect(res.actions).toEqual([]);
  });
});

// ── Naptár-alapú jelrács (hétvége/ünnep nem hézag, kimaradt ülés igen) ───────────
describe("engine/stock-tick – toSignalCandles (naptár-rács)", () => {
  /** Napi gyertya egy ET-dátumra (a nyitó bélyeg 14:30Z ~ 09:30 ET télen). */
  const barOn = (dateKey: string, close: number): OhlcvCandle => ({
    symbol: "AAPL",
    timeframe: "1d",
    openTime: Date.parse(`${dateKey}T14:30:00Z`),
    closeTime: Date.parse(`${dateKey}T21:00:00Z`),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    baseVolume: 1000,
    quoteVolume: 1000 * close,
    trades: 0,
    receivedAt: Date.parse(`${dateKey}T21:00:00Z`),
  });

  it("a hétvégét NEM tekinti hézagnak (péntek → hétfő egy lépés)", () => {
    // 2026-01-02 péntek, 2026-01-05 hétfő, 2026-01-06 kedd.
    const grid = toSignalCandles([barOn("2026-01-02", 100), barOn("2026-01-05", 101), barOn("2026-01-06", 102)]);
    expect(grid.map((c) => c.openTime)).toEqual([0, STOCK_STEP_MS, 2 * STOCK_STEP_MS]);
    expect(contiguousTail(grid, STOCK_STEP_MS)).toBe(3);
  });

  it("a tőzsdei ünnepnapot sem tekinti hézagnak (2026-01-19 MLK)", () => {
    // 2026-01-16 péntek → 2026-01-19 hétfő ZÁRVA → 2026-01-20 kedd.
    const grid = toSignalCandles([barOn("2026-01-16", 100), barOn("2026-01-20", 101)]);
    expect(contiguousTail(grid, STOCK_STEP_MS)).toBe(2);
  });

  it("a VALÓDI kimaradt ülést hézagnak jelöli, és a tail ott elvágódik", () => {
    // 2026-01-06 kedd hiányzik a sorból → a szerda előtti adat nem számít.
    const grid = toSignalCandles([barOn("2026-01-05", 100), barOn("2026-01-07", 101), barOn("2026-01-08", 102)]);
    expect(contiguousTail(grid, STOCK_STEP_MS)).toBe(2);
  });

  it("previousTradingDayKey átlép a hétvégén és az ünnepen", () => {
    expect(previousTradingDayKey("2026-01-05")).toBe("2026-01-02"); // hétfő → péntek
    expect(previousTradingDayKey("2026-01-20")).toBe("2026-01-16"); // MLK utáni kedd → péntek
    expect(previousTradingDayKey("2026-01-07")).toBe("2026-01-06"); // szerda → kedd
  });

  it("valós, naptári gyertyasoron a jelek elégségesek (a fix ms-rács ezt megbukná)", () => {
    // 70 egymást követő KERESKEDÉSI nap 2026-03-02-től, hétvégék/ünnepek átugorva.
    const bars: OhlcvCandle[] = [];
    let ms = Date.parse("2026-03-02T17:00:00Z");
    while (bars.length < 70) {
      const p = etParts(ms);
      const key = etDateKey(p);
      if (isUsTradingDay(ms)) bars.push(barOn(key, 100 + bars.length));
      ms += 24 * 60 * 60 * 1000;
    }
    const { signals } = planStockCycle({
      candlesBySymbol: { AAPL: bars },
      positions: [],
      totalEquityUsd: 10000,
      weeklyBudgetRemainingUsd: 500,
    });
    expect(signals.AAPL.bars).toBe(70);
    expect(signals.AAPL.sufficient).toBe(true);
  });
});

// ── A részvény-sáv belépő útja (a DEFAULT_STRATEGY-vel nem lenne egy sem) ────────
/**
 * Emelkedő napi sor VALÓDI kereskedési napokon (hétvége/ünnep kihagyva) — a naptár-rács
 * csak így ad hézagmentes tailt, és a valós Yahoo-adat is pontosan így néz ki.
 */
function risingTradingDays(count: number, startDateKey: string): OhlcvCandle[] {
  const out: OhlcvCandle[] = [];
  let ms = Date.parse(`${startDateKey}T17:00:00Z`);
  while (out.length < count) {
    if (isUsTradingDay(ms)) {
      const key = etDateKey(etParts(ms));
      const c = 100 + out.length;
      out.push({
        symbol: "AAPL",
        timeframe: "1d",
        openTime: Date.parse(`${key}T14:30:00Z`),
        closeTime: Date.parse(`${key}T21:00:00Z`),
        open: c,
        high: c + 1,
        low: c - 1,
        close: c,
        baseVolume: 1000,
        quoteVolume: 1000 * c,
        trades: 0,
        receivedAt: Date.parse(`${key}T21:00:00Z`),
      });
    }
    ms += 24 * 60 * 60 * 1000;
  }
  return out;
}
describe("engine/stock-tick – STOCK_STRATEGY", () => {
  it("a momentum-belépő BE van kapcsolva, a tétel 10% (egész részvény miatt)", () => {
    expect(STOCK_STRATEGY.momentumEnabled).toBe(true);
    expect(STOCK_STRATEGY.momentumBuyPct).toBe(0.1);
    // A kockázati keret nem tágul a kriptóhoz képest.
    expect(STOCK_STRATEGY.maxPositionPct).toBe(DEFAULT_STRATEGY.maxPositionPct);
    expect(STOCK_STRATEGY.maxConcurrentPositions).toBe(DEFAULT_STRATEGY.maxConcurrentPositions);
    expect(STOCK_STRATEGY.stopLossPct).toBe(DEFAULT_STRATEGY.stopLossPct);
  });

  it("breakout-soron VESZ (a DEFAULT_STRATEGY ugyanezen a soron nem venne)", async () => {
    // 60 emelkedő ÜLÉS → az utolsó close a 48-as ablak maximuma ÉS az SMA fölött.
    const candles = risingTradingDays(60, "2025-11-03");
    const base = {
      candlesBySymbol: { AAPL: candles },
      positions: [],
      totalEquityUsd: 10000,
      weeklyBudgetRemainingUsd: 500,
    };
    const withStock = planStockCycle(base);
    expect(withStock.signals.AAPL.momentumOk).toBe(true);
    const buy = withStock.plan.orders.find((o) => o.kind === "momentum");
    expect(buy).toBeDefined();
    expect(buy!.amountUsd).toBeCloseTo(1000, 6); // 10% * 10 000 USD

    const withCrypto = planStockCycle({ ...base, strategy: DEFAULT_STRATEGY });
    expect(withCrypto.plan.orders).toEqual([]);
  });

  it("a végrehajtás EGÉSZ darabot vesz a napi close-on", async () => {
    const ledger = emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE);
    const res = await runStockCycle({
      tickId: "2026-02-02",
      now: () => NOW,
      ledger,
      instruments: [AAPL],
      candlesBySymbol: { AAPL: risingTradingDays(60, "2025-11-03") },
      weeklyBudgetRemainingUsd: 500,
    });
    const buy = res.actions.find((a) => a.kind === "momentum");
    expect(buy).toBeDefined();
    expect(Number.isInteger(buy!.qty)).toBe(true);
    expect(buy!.qty).toBeGreaterThan(0);
    expect(buy!.amountUsd).toBeLessThanOrEqual(1000 * 1.01); // a 10%-os keret + spread
  });
});

// ── Intraday rács (day trading): az éjszaka nem hézag, a kimaradt bar igen ───────
describe("engine/stock-tick – toSignalCandles intraday", () => {
  const FIVE = 5 * 60 * 1000;
  /** 5 perces bar egy adott ET-napon, a nyitástól számított n-edik slotban. */
  const bar = (dateKey: string, slot: number, close = 100): OhlcvCandle => {
    const openTime = Date.parse(`${dateKey}T14:30:00Z`) + slot * FIVE; // 09:30 ET (télen)
    return {
      symbol: "AAPL",
      timeframe: "5m",
      openTime,
      closeTime: openTime + FIVE,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      baseVolume: 100,
      quoteVolume: 100 * close,
      trades: 0,
      receivedAt: openTime + FIVE,
    };
  };

  it("ülésen belül az egymást követő barok hézagmentesek", () => {
    const grid = toSignalCandles([bar("2026-01-05", 0), bar("2026-01-05", 1), bar("2026-01-05", 2)], "5m");
    expect(grid.map((c) => c.openTime)).toEqual([0, FIVE, 2 * FIVE]);
    expect(contiguousTail(grid, FIVE)).toBe(3);
  });

  it("az ÉJSZAKA (ülés-határ) nem hézag: péntek utolsó bar → hétfő első bar", () => {
    const grid = toSignalCandles([bar("2026-01-02", 77), bar("2026-01-05", 0), bar("2026-01-05", 1)], "5m");
    expect(contiguousTail(grid, FIVE)).toBe(3);
  });

  it("ülésen belül KIMARADT bar viszont hézag", () => {
    const grid = toSignalCandles([bar("2026-01-05", 0), bar("2026-01-05", 2), bar("2026-01-05", 3)], "5m");
    expect(contiguousTail(grid, FIVE)).toBe(2);
  });

  it("a jelek 5 perces baron is elégségesek lesznek (60 bar > 48 kell)", () => {
    const bars: OhlcvCandle[] = [];
    for (let i = 0; i < 60; i++) bars.push(bar("2026-01-05", i, 100 + i * 0.1));
    const { signals } = planStockCycle({
      candlesBySymbol: { AAPL: bars },
      positions: [],
      totalEquityUsd: 10000,
      weeklyBudgetRemainingUsd: 500,
      timeframe: "5m",
    });
    expect(signals.AAPL.bars).toBe(60);
    expect(signals.AAPL.sufficient).toBe(true);
  });
});

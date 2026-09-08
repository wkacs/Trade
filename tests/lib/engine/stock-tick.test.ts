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
  intradayPhaseAt,
} from "@/lib/engine/stock-tick";
import { contiguousTail } from "@/lib/engine/profit-cycle";
import { etParts, etDateKey, isUsTradingDay } from "@/lib/markets/calendar";
import { emptyLedger, type LedgerState } from "@/lib/portfolio/ledger";
import { findInstrument } from "@/lib/markets/registry";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import { riskAdjustedRank } from "@/lib/strategy/momentum-ranking";
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
    const candles = risingTradingDaysEnding(60, "2026-02-02");
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
      candlesBySymbol: { AAPL: risingTradingDaysEnding(60, "2026-02-02") },
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

// ── Day trading: ülés-fázisok és nap végi laposra zárás ─────────────────────────
describe("engine/stock-tick – intradayPhaseAt", () => {
  const at = (utc: string) => intradayPhaseAt(Date.parse(utc));

  it("zárt piacon nincs ciklus", () => {
    expect(at("2026-02-02T14:00:00Z")).toMatchObject({ due: false, phase: "closed", reason: "pre-market" });
    expect(at("2026-02-01T18:00:00Z")).toMatchObject({ due: false, phase: "closed", reason: "weekend" });
    expect(at("2026-02-02T22:00:00Z")).toMatchObject({ due: false, phase: "closed", reason: "after-hours" });
  });

  it("ülés közben teljes ciklus, a hátralévő perccel", () => {
    expect(at("2026-02-02T15:00:00Z")).toMatchObject({ due: true, phase: "trading", minutesToClose: 360 });
  });

  it("zárás előtt 30 percen belül nincs ÚJ belépő", () => {
    expect(at("2026-02-02T20:40:00Z")).toMatchObject({ due: true, phase: "no-new-entries", minutesToClose: 20 });
  });

  it("zárás előtt 10 percen belül MINDENT zárunk", () => {
    expect(at("2026-02-02T20:55:00Z")).toMatchObject({ due: true, phase: "flatten", minutesToClose: 5 });
  });
});

describe("engine/stock-tick – nap végi laposra zárás", () => {
  const flatCandles = { AAPL: daily([{ o: 100, h: 101, l: 99, c: 100 }]) };

  it("flatten fázisban a nyitott pozíció ELADÓDIK, akkor is, ha nincs stop/TP jel", async () => {
    const res = await runStockCycle({
      tickId: "flat",
      now: () => NOW,
      ledger: ledgerWithPosition("3", "290", "80"),
      instruments: [AAPL],
      candlesBySymbol: flatCandles,
      phase: "flatten",
    });
    const flat = res.actions.find((a) => a.kind === "eod-flat");
    expect(flat).toMatchObject({ side: "SELL", symbol: "AAPL", qty: 3 });
    expect(res.ledger.positions.AAPL).toBeUndefined();
  });

  it("trading fázisban ugyanez a pozíció NEM záródik", async () => {
    const res = await runStockCycle({
      tickId: "keep",
      now: () => NOW,
      ledger: ledgerWithPosition("3", "290", "80"),
      instruments: [AAPL],
      candlesBySymbol: flatCandles,
      phase: "trading",
    });
    expect(res.actions.find((a) => a.kind === "eod-flat")).toBeUndefined();
    expect(res.ledger.positions.AAPL?.qty).toBe("3");
  });

  it("no-new-entries fázisban breakout-soron sem VESZ", async () => {
    const bars = risingTradingDaysEnding(60, "2026-02-02");
    const res = await runStockCycle({
      tickId: "cutoff",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: bars },
      phase: "no-new-entries",
    });
    expect(res.actions.filter((a) => a.side === "BUY")).toEqual([]);
  });
});

describe("engine/stock-tick – belépő-tiltás és tört lot", () => {
  const bars = () => risingTradingDaysEnding(60, "2026-02-02");

  it("a tiltott papírba NEM lép be, de a meglévő pozíciót kezeli", async () => {
    const res = await runStockCycle({
      tickId: "blocked",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: bars() },
      entryBlocked: new Set(["AAPL"]),
    });
    expect(res.actions).toEqual([]);

    const allowed = await runStockCycle({
      tickId: "allowed",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: bars() },
    });
    expect(allowed.actions.find((a) => a.side === "BUY")).toBeDefined();
  });

  it("tört lottal a mennyiség NEM egész, és pontosabban használja a keretet", async () => {
    const whole = await runStockCycle({
      tickId: "whole",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: bars() },
    });
    const frac = await runStockCycle({
      tickId: "frac",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: bars() },
      fractional: true,
    });
    const w = whole.actions.find((a) => a.side === "BUY")!;
    const f = frac.actions.find((a) => a.side === "BUY")!;
    expect(Number.isInteger(w.qty)).toBe(true);
    expect(Number.isInteger(f.qty)).toBe(false);
    // A tört lot közelebb visz a 10%-os kerethez (1000 USD), mint az egészre kerekítés.
    expect(Math.abs(1000 - f.amountUsd)).toBeLessThan(Math.abs(1000 - w.amountUsd));
  });
});

describe("intradayPhaseAt – korai zárású (fél-napos) ülés", () => {
  // 2026-11-27 péntek, hálaadás utáni nap: 09:30–13:00 ET (EST = UTC−5).
  const half = (etHour: number, etMin: number) => Date.UTC(2026, 10, 27, etHour + 5, etMin);

  it("12:00-kor még kereskedik (60 perc a zárásig)", () => {
    const g = intradayPhaseAt(half(12, 0));
    expect(g).toMatchObject({ due: true, phase: "trading", minutesToClose: 60 });
  });

  it("12:35-kor már NEM nyit új pozíciót", () => {
    expect(intradayPhaseAt(half(12, 35)).phase).toBe("no-new-entries");
  });

  it("12:55-kor laposra zár — nem 15:50-kor, három órával a valódi záró után", () => {
    expect(intradayPhaseAt(half(12, 55)).phase).toBe("flatten");
  });

  it("13:30-kor már zárva (korábban 16:00-ig kereskedett volna)", () => {
    expect(intradayPhaseAt(half(13, 30))).toMatchObject({ due: false, phase: "closed" });
  });
});

// ── Momentum-rangsor a döntés-agyban (a szélesség kiválasztási kérdése) ──────────
/**
 * Emelkedő sor VALÓDI kereskedési napokon, állítható gyertya-szélességgel (ez adja az
 * ATR-t) és opcionális záró-ugrással (ez adja a nyers periódus-változást).
 */
function volSeries(
  symbol: string,
  count: number,
  startDateKey: string,
  opts: { halfRange: number; lastClose?: number },
): OhlcvCandle[] {
  const out: OhlcvCandle[] = [];
  let ms = Date.parse(`${startDateKey}T17:00:00Z`);
  while (out.length < count) {
    if (isUsTradingDay(ms)) {
      const key = etDateKey(etParts(ms));
      const isLast = out.length === count - 1;
      const c = isLast && opts.lastClose !== undefined ? opts.lastClose : 100 + out.length;
      out.push({
        symbol,
        timeframe: "1d",
        openTime: Date.parse(`${key}T14:30:00Z`),
        closeTime: Date.parse(`${key}T21:00:00Z`),
        open: c,
        high: c + opts.halfRange,
        low: c - opts.halfRange,
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

describe("engine/stock-tick – momentum-rangsor", () => {
  // CALM: apró gyertyák, apró záró-lépés. WILD: széles gyertyák, nagy záró-ugrás.
  const base = {
    candlesBySymbol: {
      CALM: volSeries("CALM", 60, "2025-11-03", { halfRange: 0.25, lastClose: 162 }),
      WILD: volSeries("WILD", 60, "2025-11-03", { halfRange: 5, lastClose: 168 }),
    },
    positions: [],
    totalEquityUsd: 10000,
    weeklyBudgetRemainingUsd: 500,
  };

  it("mindkét papír kitörésben van (a rangsor dönt, nem a jogosultság)", () => {
    const { signals } = planStockCycle(base);
    expect(signals.CALM.momentumOk).toBe(true);
    expect(signals.WILD.momentumOk).toBe(true);
  });

  it("alap rangsorral a nagyobb nyers ugrás nyer (a volatilisebb papír)", () => {
    const { plan } = planStockCycle(base);
    const buy = plan.orders.find((o) => o.kind === "momentum");
    expect(buy?.symbol).toBe("WILD");
  });

  it("kockázat-korrigált rangsorral a nyugodtabb papír nyer", () => {
    const { plan } = planStockCycle({ ...base, momentumRanking: riskAdjustedRank });
    const buy = plan.orders.find((o) => o.kind === "momentum");
    expect(buy?.symbol).toBe("CALM");
  });

  it("a rangsor az ATR-t az ÁRHOZ mérten kapja (a drágább papír nem kap előnyt)", () => {
    // Ugyanaz az alak tízszeres árszinten: az arányok, tehát a sorrend sem változhat.
    const scaled = {
      ...base,
      candlesBySymbol: {
        CALM: base.candlesBySymbol.CALM.map((c) => ({ ...c, open: c.open * 10, high: c.high * 10, low: c.low * 10, close: c.close * 10 })),
        WILD: base.candlesBySymbol.WILD.map((c) => ({ ...c, open: c.open * 10, high: c.high * 10, low: c.low * 10, close: c.close * 10 })),
      },
    };
    const { plan } = planStockCycle({ ...scaled, momentumRanking: riskAdjustedRank });
    expect(plan.orders.find((o) => o.kind === "momentum")?.symbol).toBe("CALM");
  });
});

// ── Napi veszteségkapu a részvény-sávon (audit 1. pont) ─────────────────────────

describe("engine/stock-tick – napi veszteségkapu", () => {
  const breakout = { AAPL: risingTradingDaysEnding(60, "2026-02-02") };

  it("kapu nélkül (mai állapot) a breakout VESZ — ez a kontroll", async () => {
    const res = await runStockCycle({
      tickId: "gate-control",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: breakout,
      weeklyBudgetRemainingUsd: 500,
    });
    expect(res.actions.find((a) => a.kind === "momentum")).toBeDefined();
  });

  it("latch-elt napi veszteség mellett NINCS új belépő", async () => {
    const res = await runStockCycle({
      tickId: "gate-latched",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: breakout,
      weeklyBudgetRemainingUsd: 500,
      resolveDayGate: () => ({ latched: true, baselineMissing: false }),
    });
    expect(res.actions.find((a) => a.kind === "momentum")).toBeUndefined();
  });

  it("hiányzó napkezdő referencia mellett sincs új belépő", async () => {
    const res = await runStockCycle({
      tickId: "gate-missing",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: breakout,
      weeklyBudgetRemainingUsd: 500,
      resolveDayGate: () => ({ latched: false, baselineMissing: true }),
    });
    expect(res.actions.find((a) => a.kind === "momentum")).toBeUndefined();
  });

  it("a kapu a VÉDELMI kilépést nem blokkolja: a nap végi zárás latch mellett is lefut", async () => {
    const res = await runStockCycle({
      tickId: "gate-flatten",
      now: () => NOW,
      ledger: ledgerWithPosition("3", "290", "80"),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: daily([{ o: 100, h: 101, l: 99, c: 100 }]) },
      phase: "flatten",
      resolveDayGate: () => ({ latched: true, baselineMissing: true }),
    });
    expect(res.actions.find((a) => a.kind === "eod-flat")).toBeDefined();
    expect(res.ledger.positions.AAPL).toBeUndefined();
  });

  it("a kapu az AKTUÁLIS equityt kapja meg (a döntés előtti állapotot)", async () => {
    let seen: number | null = null;
    await runStockCycle({
      tickId: "gate-equity",
      now: () => NOW,
      ledger: ledgerWithPosition("3", "290", "80"), // 10 000 készpénz + 3 × 100 USD
      instruments: [AAPL],
      candlesBySymbol: { AAPL: daily([{ o: 100, h: 101, l: 99, c: 100 }]) },
      resolveDayGate: (equityUsd) => {
        seen = Number(equityUsd);
        return { latched: false, baselineMissing: false };
      },
    });
    expect(seen).toBe(10300);
  });
});

// ── Zárhatóság: a nap végi zárás nem függhet a BELÉPŐ metaadat-kapujától (audit 3.) ──

describe("engine/stock-tick – a zárás mindig a teljes készletet zárja", () => {
  const flatCandles = { AAPL: daily([{ o: 100, h: 101, l: 99, c: 100 }]) };

  it("TÖRT pozíciót is teljesen zár, akkor is, ha a tört-belépő kapu ZÁRVA van", async () => {
    const res = await runStockCycle({
      tickId: "flat-fraction",
      now: () => NOW,
      ledger: ledgerWithPosition("1.5", "150", "80"),
      instruments: [AAPL],
      candlesBySymbol: flatCandles,
      phase: "flatten",
      fractional: false, // az Alpaca metaadat nem igazolta vissza → új belépő egész lot
    });
    const flat = res.actions.find((a) => a.kind === "eod-flat");
    expect(flat?.qty).toBe(1.5);
    expect(res.ledger.positions.AAPL).toBeUndefined();
    expect(res.unflattened).toEqual([]);
  });

  it("egy darab alatti pozíciót is zár (ez korábban egyáltalán nem volt zárható)", async () => {
    const res = await runStockCycle({
      tickId: "flat-small",
      now: () => NOW,
      ledger: ledgerWithPosition("0.5", "50", "80"),
      instruments: [AAPL],
      candlesBySymbol: flatCandles,
      phase: "flatten",
      fractional: false,
    });
    expect(res.actions.find((a) => a.kind === "eod-flat")?.qty).toBe(0.5);
    expect(res.ledger.positions.AAPL).toBeUndefined();
  });

  it("a BELÉPŐ viszont marad egész lot, ha a metaadat nem igazolta a törtet", async () => {
    const res = await runStockCycle({
      tickId: "entry-whole",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: risingTradingDaysEnding(60, "2026-02-02") },
      weeklyBudgetRemainingUsd: 500,
      fractional: false,
    });
    const buy = res.actions.find((a) => a.kind === "momentum");
    expect(buy).toBeDefined();
    expect(Number.isInteger(buy!.qty)).toBe(true);
  });

  it("adathiány miatt NYITVA maradt pozíciót megnevezve jelenti (nem néma siker)", async () => {
    const res = await runStockCycle({
      tickId: "flat-nodata",
      now: () => NOW,
      ledger: ledgerWithPosition("2", "200", "80"),
      instruments: [AAPL],
      candlesBySymbol: {}, // nincs gyertya egyetlen papírra sem
      phase: "flatten",
    });
    expect(res.actions.find((a) => a.kind === "eod-flat")).toBeUndefined();
    expect(res.unflattened).toEqual(["AAPL"]);
    expect(res.ledger.positions.AAPL).toBeDefined();
  });
});

// ── Adat-frissesség kapu (audit 2. pont, rész) ──────────────────────────────────

/** Emelkedő sor, ami a megadott ET-napon ÉR VÉGET (a „ma lezárult bar" esete). */
function risingTradingDaysEnding(count: number, endDateKey: string): OhlcvCandle[] {
  const days: string[] = [];
  let ms = Date.parse(`${endDateKey}T17:00:00Z`);
  while (days.length < count) {
    if (isUsTradingDay(ms)) days.unshift(etDateKey(etParts(ms)));
    ms -= 24 * 60 * 60 * 1000;
  }
  return days.map((key, i) => {
    const c = 100 + i;
    return {
      symbol: "AAPL",
      timeframe: "1d" as const,
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
    };
  });
}

describe("engine/stock-tick – elavult gyertyából nincs ÚJ belépő", () => {
  const fresh = risingTradingDaysEnding(60, "2026-02-02"); // a mai ülés lezárt bara

  it("friss adaton a breakout VESZ — ez a kontroll", async () => {
    const res = await runStockCycle({
      tickId: "fresh",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: fresh },
      weeklyBudgetRemainingUsd: 500,
    });
    expect(res.actions.find((a) => a.kind === "momentum")).toBeDefined();
    expect(res.staleSymbols).toEqual([]);
  });

  it("ELAVULT sorozatból nincs belépő, és a papír megnevezve látszik", async () => {
    const res = await runStockCycle({
      tickId: "stale",
      now: () => NOW + 5 * 24 * 60 * 60 * 1000, // 5 nappal az utolsó bar után
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: fresh },
      weeklyBudgetRemainingUsd: 500,
    });
    expect(res.actions.find((a) => a.kind === "momentum")).toBeUndefined();
    expect(res.staleSymbols).toEqual(["AAPL"]);
  });

  it("elavult adat mellett a VÉDELMI kilépés megmarad (a zárás nem tiltott)", async () => {
    const res = await runStockCycle({
      tickId: "stale-flat",
      now: () => NOW + 5 * 24 * 60 * 60 * 1000,
      ledger: ledgerWithPosition("3", "290", "80"),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: fresh },
      phase: "flatten",
    });
    const closing = res.actions.find((a) => a.side === "SELL");
    expect(closing).toBeDefined();
    expect(res.ledger.positions.AAPL).toBeUndefined();
    expect(res.unflattened).toEqual([]);
  });

  it("a küszöb felülírható (a backteszt és a demó saját idővonalon fut)", async () => {
    const res = await runStockCycle({
      tickId: "stale-override",
      now: () => NOW + 5 * 24 * 60 * 60 * 1000,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: fresh },
      weeklyBudgetRemainingUsd: 500,
      maxBarAgeMs: 10 * 24 * 60 * 60 * 1000,
    });
    expect(res.actions.find((a) => a.kind === "momentum")).toBeDefined();
  });
});

describe("engine/stock-tick – végrehajtási ár felülírás (mérés)", () => {
  const fresh = risingTradingDaysEnding(60, "2026-02-02");

  it("a JEL a lezárt gyertyából jön, a FILL a megadott végrehajtási árból", async () => {
    const res = await runStockCycle({
      tickId: "exec-px",
      now: () => NOW,
      ledger: emptyLedger(STOCK_PORTFOLIO_ID, "paper", "10000", STOCK_QUOTE),
      instruments: [AAPL],
      candlesBySymbol: { AAPL: fresh },
      weeklyBudgetRemainingUsd: 500,
      // A jel a 159-es záróból született; a következő elérhető ár viszont 200.
      executionPrices: { AAPL: "200" },
    });
    const buy = res.actions.find((a) => a.kind === "momentum");
    expect(buy).toBeDefined();
    // 10% tétel = 1000 USD. A 159-es záróból 6 darab jönne; a 200-as végrehajtási áron
    // spreaddel/slippage-dzsel együtt 1000/200,2 = 4,99 → 4 egész darab.
    expect(buy!.qty).toBe(4);
  });
});

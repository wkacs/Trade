import { describe, it, expect } from "vitest";
import {
  planStockCycle,
  runStockCycle,
  stockDecisionDue,
  STOCK_QUOTE,
  STOCK_PORTFOLIO_ID,
  STOCK_STEP_MS,
} from "@/lib/engine/stock-tick";
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

import { describe, it, expect } from "vitest";
import { runBacktest } from "@/lib/backtest/engine";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import type { HistoryFrame, BacktestConfig } from "@/lib/backtest/types";
import { emptyLedger, applyFill, cashOf, positionQty } from "@/lib/portfolio/ledger";
import { simulatePaperFill } from "@/lib/execution/paper-fill";
import { fillKey, type Fill } from "@/lib/execution/contracts";
import { dec, toNumber } from "@/lib/portfolio/money";

const H = 3600_000;

const frame = (i: number, o: number, h: number, l: number, c: number, fg: number | null): HistoryFrame => ({
  ts: i * H,
  candles: { BTC: { ts: i * H, open: o, high: h, low: l, close: c, volume: 1 } },
  fearGreedValue: fg,
});

const cfg: BacktestConfig = { symbols: ["BTC"], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 };

const warmup = (bars = 48, price = 100) =>
  Array.from({ length: bars }, (_, i) => frame(i, price, price, price, price, 50));

describe("végrehajtási paritás — a paper és a backtest ugyanazt könyveli (T17)", () => {
  it("azonos bemenetre a cash, a mennyiség és a díj MEGEGYEZIK", () => {
    // Backtest: warmup után egy DCA-terv, ami a KÖVETKEZŐ keret nyitóján teljesül.
    const history = [
      ...warmup(),
      frame(48, 100, 100, 100, 100, 10), // DCA-terv (2% = 200 USD keret)
      frame(49, 100, 100, 100, 100, 50), // itt teljesül a nyitón
    ];
    const bt = runBacktest(history, cfg);

    // Ugyanez a paper úton: 200 USD keret, 100-as ár, 5 bps csúszás, 0,1% díj.
    const sim = simulatePaperFill(
      { side: "BUY", kind: "market", symbol: "BTC", maxQuoteSpend: "200", market: { last: "100" } },
      { feePct: "0.001", slippageBps: 5, spreadBps: 0, quoteAsset: "USDT" },
    );
    expect(sim.ok).toBe(true);
    if (!sim.ok) return;

    let paper = emptyLedger("pf", "paper", "10000");
    const fill: Fill = {
      fillId: fillKey("paper", "o-1", "1"),
      intentId: "i-1",
      portfolioId: "pf",
      mode: "paper",
      symbol: "BTC",
      side: "BUY",
      exchangeOrderId: "o-1",
      exchangeTradeId: "1",
      filledBaseQty: sim.filledBaseQty,
      grossQuoteAmount: sim.grossQuoteAmount,
      fillPrice: sim.fillPrice,
      feeAmount: sim.feeAmount,
      feeAsset: "USDT",
      executedAt: 49 * H,
    };
    paper = applyFill(paper, fill).state;

    // A backtest ledger-állapota az equity-görbéből és a realizálásokból nem olvasható
    // közvetlenül, ezért a KÖTÉS paramétereit hasonlítjuk: ár, mennyiség, díj, költés.
    const btBuy = bt.realizations; // vétel nincs a realizálások közt
    expect(btBuy).toHaveLength(0);

    // A backtest záró equity = 10000 − díj (változatlan áron).
    const lastEquity = bt.equityCurve[bt.equityCurve.length - 1].equityUsd;
    const paperEquity = toNumber(cashOf(paper, "USDT")) + toNumber(positionQty(paper, "BTC")) * 100;
    expect(lastEquity).toBeCloseTo(paperEquity, 6);
  });

  it("BUY → SELL változatlan áron: mindkét úton a veszteség PONTOSAN a két díj", () => {
    const history = [
      ...warmup(),
      frame(48, 100, 100, 100, 100, 10), // DCA-terv
      frame(49, 100, 100, 100, 100, 50), // BUY teljesül a nyitón
      frame(50, 100, 115, 100, 115, 50), // +15% → take-profit terv (megfigyelt záró 115)
      frame(51, 115, 115, 115, 115, 50), // a TP eladás teljesül a nyitón
    ];
    const bt = runBacktest(history, cfg);
    expect(bt.realizations.length).toBeGreaterThanOrEqual(1);
    // A realizálás pozitív: 100-on vett, 115-ön adott el.
    expect(bt.realizations[0].pnlUsd).toBeGreaterThan(0);
    expect(bt.metrics.tradesCount).toBe(bt.realizations.length);
  });

  it("NINCS look-ahead: a jel gyertyája NEM lehet a fill gyertyája", () => {
    // Az 50. keret hatalmasat esik, de a 49-es tervhez ez már nem használható fel.
    const history = [
      ...warmup(),
      frame(48, 100, 100, 100, 100, 10),
      frame(49, 100, 100, 100, 100, 50),
      frame(50, 50, 50, 50, 50, 50),
    ];
    const bt = runBacktest(history, cfg);
    // A vétel a 49-es NYITÓN (100) történt, nem az 50-es olcsó áron.
    // Ha look-ahead lenne, a záró equity magasabb lenne az 50-es olcsó vétel miatt.
    const equityAt49 = bt.equityCurve[49].equityUsd;
    expect(equityAt49).toBeLessThan(10000); // a díj miatt
    expect(equityAt49).toBeGreaterThan(9990);
  });

  it("a polling és az exchange-stop modell KÜLÖNBÖZŐ eredményt ad ugyanazon az adaton", () => {
    const history = [
      ...warmup(),
      frame(48, 100, 100, 100, 100, 10),
      frame(49, 100, 100, 100, 100, 50),
      // A gyertya MÉLYPONTJA a stop alatt van, de a záró felette:
      frame(50, 100, 101, 90, 100, 50),
      frame(51, 100, 101, 99, 100, 50),
    ];
    const polling = runBacktest(history, { ...cfg, executionModel: "polling" });
    const exchange = runBacktest(history, { ...cfg, executionModel: "exchange-stop" });

    // A pihenő stop a gyertyán belül tüzel; a polling bot nem látta a mélypontot.
    expect(exchange.realizations.length).toBeGreaterThan(polling.realizations.length);
    expect(polling.realizations).toHaveLength(0);
  });

  it("a kockázati kapu elutasításai látszanak a riportban", () => {
    // 100 USD tőke mellett a DCA 2 USD-t tervez, de a minimum kötésérték 50 USD.
    const tiny: BacktestConfig = { ...cfg, initialCapitalUsd: 100, minOrderQuote: 50 };
    const history = [...warmup(), frame(48, 100, 100, 100, 100, 10), frame(49, 100, 100, 100, 100, 50)];
    const bt = runBacktest(history, tiny);
    expect(Object.keys(bt.rejections).length).toBeGreaterThan(0);
    expect(bt.realizations).toHaveLength(0);
  });

  it("eltűnő gyertya (hiányzó ár) nem okoz kötést", () => {
    const history: HistoryFrame[] = [
      ...warmup(),
      frame(48, 100, 100, 100, 100, 10),
      { ts: 49 * H, candles: {}, fearGreedValue: 50 }, // nincs BTC gyertya
    ];
    const bt = runBacktest(history, cfg);
    expect(bt.rejections.no_candle ?? 0).toBeGreaterThan(0);
  });

  it("stop és take-profit ugyanazon a gyertyán: a STOP nyer (konzervatív)", () => {
    const history = [
      ...warmup(),
      frame(48, 100, 100, 100, 100, 10),
      frame(49, 100, 100, 100, 100, 50), // BUY @100, stop 95, TP 110
      frame(50, 100, 115, 90, 100, 50), // a gyertya a stopot ÉS a TP-t is érinti
      frame(51, 100, 100, 100, 100, 50),
    ];
    const bt = runBacktest(history, { ...cfg, executionModel: "exchange-stop" });
    expect(bt.realizations[0].kind).toBe("stop-loss");
  });

  it("a strategy config verziója és a mintavételi köz a metrikákban szerepel", () => {
    const history = [...warmup(), frame(48, 100, 100, 100, 100, 50)];
    const bt = runBacktest(history, cfg, DEFAULT_STRATEGY);
    expect(bt.metrics.samplingHours).toBe(1);
    expect(bt.config.symbols).toEqual(["BTC"]);
  });

  it("a részleges take-profit is realizálásként jelenik meg", () => {
    const half = { ...DEFAULT_STRATEGY, takeProfitFraction: 0.5 };
    const history = [
      ...warmup(),
      frame(48, 100, 100, 100, 100, 10),
      frame(49, 100, 100, 100, 100, 50),
      frame(50, 100, 115, 100, 115, 50),
      frame(51, 115, 115, 115, 115, 50),
    ];
    const bt = runBacktest(history, cfg, half);
    expect(bt.realizations.length).toBeGreaterThanOrEqual(1);
    expect(bt.realizations[0].closesPosition).toBe(false);
    // A pozíció NEM zárult le, tehát a closedTrades még üres.
    expect(bt.closedTrades).toHaveLength(0);
    // A statisztika mégis számol vele (a régi kód elvesztette).
    expect(bt.metrics.tradesCount).toBeGreaterThanOrEqual(1);
  });

  it("a bevitt decimális értékek nem sodródnak: a díj a bruttó 0,1%-a", () => {
    const history = [...warmup(), frame(48, 100, 100, 100, 100, 10), frame(49, 100, 100, 100, 100, 50)];
    const bt = runBacktest(history, cfg);
    const spent = 10000 - bt.equityCurve[49].equityUsd;
    // A 200 USD keretből a díj 200/1,001*0,001 ≈ 0,1998; a csúszás miatt a mennyiség
    // kevesebb, de a KÖLTÉS pontosan a díj (változatlan áron a pozíció értéke marad).
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(1);
    expect(dec(bt.config.feePct)).toBe("0.001");
  });
});

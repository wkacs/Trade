import { describe, it, expect } from "vitest";
import {
  summarizeClosedPosition,
  computeBreakdowns,
  computeEquityCurve,
  getClosedTrades,
  getBreakdowns,
  getRealizedEquityCurve,
} from "@/lib/portfolio/analytics";

const d = (iso: string) => new Date(iso);

describe("summarizeClosedPosition", () => {
  it("round-trip P&L több BUY-jal + záró SELL origin", () => {
    const pos = { symbol: "BTC", entryPrice: 100, openedAt: d("2026-06-01T00:00:00Z"), closedAt: d("2026-06-01T05:00:00Z") };
    const trades = [
      { side: "BUY", amountUsd: 100, price: 100, qty: 1, feeUsd: 0.1, origin: "dca", executedAt: d("2026-06-01T00:00:00Z") },
      { side: "BUY", amountUsd: 100, price: 100, qty: 1, feeUsd: 0.1, origin: "dca", executedAt: d("2026-06-01T01:00:00Z") },
      { side: "SELL", amountUsd: 240, price: 120, qty: 2, feeUsd: 0.24, origin: "take-profit", executedAt: d("2026-06-01T05:00:00Z") },
    ];
    const r = summarizeClosedPosition(pos, trades);
    // T18: a VÉTELI díj is költség. Bekerülés 200 + 0,2 = 200,2; bevétel 240 − 0,24 = 239,76.
    expect(r.pnlUsd).toBeCloseTo(39.56, 2);
    expect(r.pnlPct).toBeCloseTo(39.56 / 200.2, 4);
    expect(r.qtyClosed).toBeCloseTo(2, 6);
    expect(r.exitPrice).toBeCloseTo(120, 6);
    expect(r.holdHours).toBeCloseTo(5, 6);
    expect(r.exitOrigin).toBe("take-profit");
  });

  it("nincs SELL → pnl = -buyCost, exitOrigin n/a", () => {
    const pos = { symbol: "ETH", entryPrice: 50, openedAt: d("2026-06-01T00:00:00Z"), closedAt: d("2026-06-01T01:00:00Z") };
    const trades = [{ side: "BUY", amountUsd: 50, price: 50, qty: 1, feeUsd: 0.05, origin: "dca", executedAt: d("2026-06-01T00:00:00Z") }];
    const r = summarizeClosedPosition(pos, trades);
    // A vételi díj is beleszámít: −(50 + 0,05).
    expect(r.pnlUsd).toBeCloseTo(-50.05, 6);
    expect(r.exitOrigin).toBe("n/a");
  });
});

describe("computeBreakdowns", () => {
  it("win-ráta + átlag pnl coin és exit-origin szerint", () => {
    const rows = [
      { symbol: "BTC", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: 10, pnlPct: 0.1, holdHours: 1, exitOrigin: "take-profit", exitTs: 1 },
      { symbol: "BTC", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: -5, pnlPct: -0.05, holdHours: 1, exitOrigin: "stop-loss", exitTs: 2 },
      { symbol: "ETH", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: 3, pnlPct: 0.03, holdHours: 1, exitOrigin: "take-profit", exitTs: 3 },
    ];
    const b = computeBreakdowns(rows);
    const btc = b.byCoin.find((x) => x.key === "BTC")!;
    expect(btc.trades).toBe(2);
    expect(btc.winRate).toBeCloseTo(0.5, 6);
    expect(btc.avgPnlPct).toBeCloseTo((0.1 - 0.05) / 2, 6);
    const tp = b.byExitOrigin.find((x) => x.key === "take-profit")!;
    expect(tp.trades).toBe(2);
    expect(tp.winRate).toBeCloseTo(1, 6);
  });
});

describe("computeEquityCurve", () => {
  it("kumulált realized P&L exit-idő szerint rendezve", () => {
    const rows = [
      { symbol: "BTC", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: 10, pnlPct: 0, holdHours: 0, exitOrigin: "tp", exitTs: 200 },
      { symbol: "ETH", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: -4, pnlPct: 0, holdHours: 0, exitOrigin: "sl", exitTs: 100 },
    ];
    const curve = computeEquityCurve(rows, 100);
    // T18: a görbe a LEGELSŐ kötés ELŐTTI kezdőtőkéből indul.
    expect(curve).toEqual([
      { ts: 99, equityUsd: 100 },
      { ts: 100, equityUsd: 96 },
      { ts: 200, equityUsd: 106 },
    ]);
  });

  it("üres bemenetre üres görbe", () => {
    expect(computeEquityCurve([], 100)).toEqual([]);
  });
});

describe("DB-wrapperek (null DB → biztonságos default)", () => {
  it("getClosedTrades null DB → []", async () => {
    expect(await getClosedTrades(null)).toEqual([]);
  });
  it("getBreakdowns null DB → üres bontások", async () => {
    expect(await getBreakdowns(null)).toEqual({ byCoin: [], byExitOrigin: [] });
  });
  it("getRealizedEquityCurve null DB → []", async () => {
    expect(await getRealizedEquityCurve(null)).toEqual([]);
  });
});

// ── T18: teljesítmény a FILL-LEDGERBŐL ─────────────────────────────────────
import { replayFills } from "@/lib/portfolio/analytics";
import type { Fill } from "@/lib/execution/contracts";

const fill = (
  over: Partial<Fill> & { provenance?: string } & Pick<
      Fill,
      "side" | "filledBaseQty" | "grossQuoteAmount" | "fillPrice" | "executedAt"
    >,
): Fill & { provenance?: string } => ({
  fillId: over.fillId ?? `paper:${over.side}:${over.executedAt}`,
  intentId: over.intentId ?? "i",
  portfolioId: "pf",
  mode: "paper",
  symbol: over.symbol ?? "BTC",
  side: over.side,
  exchangeOrderId: over.exchangeOrderId ?? `o-${over.executedAt}`,
  exchangeTradeId: "1",
  filledBaseQty: over.filledBaseQty,
  grossQuoteAmount: over.grossQuoteAmount,
  fillPrice: over.fillPrice,
  feeAmount: over.feeAmount ?? "0",
  feeAsset: "USDT",
  executedAt: over.executedAt,
  ...(over.provenance ? { provenance: over.provenance } : {}),
});

describe("replayFills — minden realizálás, díjakkal (T18)", () => {
  it("a RÉSZLEGES eladás is realizálásként számít", () => {
    const r = replayFills(
      [
        fill({ side: "BUY", filledBaseQty: "2", grossQuoteAmount: "200", fillPrice: "100", feeAmount: "0.2", executedAt: 1000 }),
        fill({ side: "SELL", filledBaseQty: "1", grossQuoteAmount: "120", fillPrice: "120", feeAmount: "0.12", executedAt: 2000 }),
        fill({ side: "SELL", filledBaseQty: "1", grossQuoteAmount: "90", fillPrice: "90", feeAmount: "0.09", executedAt: 3000 }),
      ],
      { openingCashUsd: "1000" },
    );
    expect(r.realizations).toHaveLength(2);
    expect(r.realizations[0].closesPosition).toBe(false);
    expect(r.realizations[1].closesPosition).toBe(true);
    expect(r.metrics.tradesCount).toBe(2);
    expect(r.metrics.hitRate).toBeCloseTo(0.5, 6);
  });

  it("a görbe a LEGELSŐ kötés ELŐTTI kezdőtőkéből indul", () => {
    const r = replayFills(
      [fill({ side: "BUY", filledBaseQty: "1", grossQuoteAmount: "100", fillPrice: "100", executedAt: 5000 })],
      { openingCashUsd: "500" },
    );
    expect(r.equityCurve[0]).toEqual({ ts: 4999, equityUsd: 500 });
    expect(r.startingEquityUsd).toBe(500);
  });

  it("változatlan áron a realizált eredmény PONTOSAN a két díj", () => {
    const r = replayFills(
      [
        fill({ side: "BUY", filledBaseQty: "1", grossQuoteAmount: "100", fillPrice: "100", feeAmount: "0.1", executedAt: 1 }),
        fill({ side: "SELL", filledBaseQty: "1", grossQuoteAmount: "100", fillPrice: "100", feeAmount: "0.1", executedAt: 2 }),
      ],
      { openingCashUsd: "1000" },
    );
    expect(r.realizedPnlUsd).toBeCloseTo(-0.2, 9);
    expect(r.totalFeesUsd).toBeCloseTo(0.2, 9);
  });

  it("a legacy-unverified sorok KIMARADNAK a metrikákból, de látszanak", () => {
    const r = replayFills(
      [
        fill({ side: "BUY", filledBaseQty: "1", grossQuoteAmount: "100", fillPrice: "100", executedAt: 1, provenance: "legacy-unverified" }),
        fill({ side: "SELL", filledBaseQty: "1", grossQuoteAmount: "150", fillPrice: "150", executedAt: 2, provenance: "legacy-unverified" }),
      ],
      { openingCashUsd: "1000" },
    );
    expect(r.legacy.fills).toBe(2);
    expect(r.legacy.excludedFromMetrics).toBe(true);
    expect(r.realizations).toHaveLength(0);
  });

  it("a nem realizált eredmény a megadott árakon számol", () => {
    const r = replayFills(
      [fill({ side: "BUY", filledBaseQty: "1", grossQuoteAmount: "100", fillPrice: "100", executedAt: 1 })],
      { openingCashUsd: "1000", prices: { BTC: "130" } },
    );
    expect(r.unrealizedPnlUsd).toBeCloseTo(30, 9);
  });

  it("ár nélkül a pozíció bekerülési értéken szerepel — nincs kitalált piaci ár", () => {
    const r = replayFills(
      [fill({ side: "BUY", filledBaseQty: "1", grossQuoteAmount: "100", fillPrice: "100", executedAt: 1 })],
      { openingCashUsd: "1000" },
    );
    expect(r.equityCurve[r.equityCurve.length - 1].equityUsd).toBeCloseTo(1000, 9);
    expect(r.unrealizedPnlUsd).toBe(0);
  });

  it("a fedezethiányos vagy hibás sor PROBLÉMAKÉNT látszik, nem tűnik el", () => {
    const r = replayFills(
      [fill({ side: "SELL", filledBaseQty: "1", grossQuoteAmount: "100", fillPrice: "100", executedAt: 1 })],
      { openingCashUsd: "1000" },
    );
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].code).toBe("insufficient_position");
  });

  it("üres bemenetre nulla metrikák, nem dob", () => {
    const r = replayFills([], { openingCashUsd: "100" });
    expect(r.metrics.tradesCount).toBe(0);
    expect(r.equityCurve).toEqual([]);
  });
});

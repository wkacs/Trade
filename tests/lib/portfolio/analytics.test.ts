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
    expect(r.pnlUsd).toBeCloseTo(39.76, 2); // 239.76 - 200
    expect(r.pnlPct).toBeCloseTo(39.76 / 200, 4);
    expect(r.qtyClosed).toBeCloseTo(2, 6);
    expect(r.exitPrice).toBeCloseTo(120, 6);
    expect(r.holdHours).toBeCloseTo(5, 6);
    expect(r.exitOrigin).toBe("take-profit");
  });

  it("nincs SELL → pnl = -buyCost, exitOrigin n/a", () => {
    const pos = { symbol: "ETH", entryPrice: 50, openedAt: d("2026-06-01T00:00:00Z"), closedAt: d("2026-06-01T01:00:00Z") };
    const trades = [{ side: "BUY", amountUsd: 50, price: 50, qty: 1, feeUsd: 0.05, origin: "dca", executedAt: d("2026-06-01T00:00:00Z") }];
    const r = summarizeClosedPosition(pos, trades);
    expect(r.pnlUsd).toBeCloseTo(-50, 6);
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
    expect(curve).toEqual([
      { ts: 100, equityUsd: 96 },
      { ts: 200, equityUsd: 106 },
    ]);
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

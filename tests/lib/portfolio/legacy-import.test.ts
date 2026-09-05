import { describe, it, expect } from "vitest";
import {
  planLegacyImport,
  buildDiff,
  detectOverweight,
  legacyOrderId,
  formatPlanSummary,
  type LegacyInput,
} from "@/lib/portfolio/legacy-import";

const ts = (iso: string) => new Date(iso);

const legacy: LegacyInput = {
  portfolio: { id: "pf-1", initialCapitalUsd: 100, cashUsd: 0.09354296, mode: "paper" },
  positions: [
    { id: "p1", symbol: "BTC", qty: 0.001688317, entryPrice: 59000, stopPrice: 56050, closedAt: null },
    { id: "p2", symbol: "ETH", qty: 0.000008429329, entryPrice: 3000, stopPrice: 2850, closedAt: null },
    { id: "p3", symbol: "SOL", qty: 0, entryPrice: 150, stopPrice: 142.5, closedAt: ts("2026-07-01T00:00:00Z") },
  ],
  trades: [
    { id: "t1", positionId: "p1", symbol: "BTC", side: "BUY", amountUsd: 2, price: 59000, qty: 0.0000338, feeUsd: 0.002, mode: "paper", executedAt: ts("2026-07-01T00:00:00Z"), origin: "ai" },
    { id: "t2", positionId: "p1", symbol: "BTC", side: "BUY", amountUsd: 3, price: 60000, qty: 0.00005, feeUsd: 0.003, mode: "paper", executedAt: ts("2026-07-02T00:00:00Z"), origin: null },
    { id: "t3", positionId: "p3", symbol: "SOL", side: "SELL", amountUsd: 4, price: 145, qty: 0.0275, feeUsd: 0.004, mode: "paper", executedAt: ts("2026-07-03T00:00:00Z"), origin: "stop-loss" },
    { id: "t4", positionId: null, symbol: "ETH", side: "BUY", amountUsd: 0, price: 3000, qty: 0, feeUsd: 0, mode: "paper", executedAt: ts("2026-07-04T00:00:00Z"), origin: "dca" },
  ],
};

const plan = () => planLegacyImport(legacy, { epochVersion: "v2-2026-09-05" });

describe("legacy-import — a régi adatot megőrizzük, nem javítjuk ki", () => {
  it("a nyitóállapot az ELLENŐRZÖTT v1 állapotból jön, nem a trade-ek újrajátszásából", () => {
    const p = plan();
    expect(p.openingCashQuote).toBe("0.09354296");
    expect(p.openingPositions.map((x) => x.symbol)).toEqual(["BTC", "ETH"]);
    expect(p.openingPositions[0].qty).toBe("0.001688317");
    // A lezárt, nulla mennyiségű pozíció nem kerül be.
    expect(p.openingPositions.find((x) => x.symbol === "SOL")).toBeUndefined();
  });

  it("a történeti sorok legacy-unverified provenance-t kapnak", () => {
    const p = plan();
    expect(p.legacyFills).toHaveLength(3); // a nullás sor kimarad
    for (const f of p.legacyFills) expect(f.provenance).toBe("legacy-unverified");
  });

  it("a hiányzó tőzsdei orderId SZINTETIKUS és felismerhető, nem kitalált tőzsdei adat", () => {
    const p = plan();
    expect(p.legacyFills[0].exchangeOrderId).toBe(legacyOrderId("t1"));
    expect(p.legacyFills[0].exchangeOrderId.startsWith("legacy:")).toBe(true);
    expect(p.warnings.some((w) => w.code === "synthetic_order_id")).toBe(true);
  });

  it("a hiányzó eredetet JELÖLI, nem találja ki", () => {
    const p = plan();
    const w = p.warnings.filter((x) => x.code === "missing_origin");
    expect(w).toHaveLength(1);
    expect(w[0].tradeId).toBe("t2");
  });

  it("az irreális stop-fill árat JELÖLI, de nem javítja", () => {
    const withStop: LegacyInput = {
      ...legacy,
      positions: [{ id: "p9", symbol: "BTC", qty: 1, entryPrice: 100, stopPrice: 95, closedAt: null }],
      trades: [
        {
          id: "t9",
          positionId: "p9",
          symbol: "BTC",
          side: "SELL",
          amountUsd: 95,
          price: 95,
          qty: 1,
          feeUsd: 0.095,
          mode: "paper",
          executedAt: ts("2026-07-05T00:00:00Z"),
          origin: "stop-loss",
        },
      ],
    };
    const p = planLegacyImport(withStop, { epochVersion: "v2" });
    const w = p.warnings.filter((x) => x.code === "suspicious_stop_fill");
    expect(w).toHaveLength(1);
    // Az ár VÁLTOZATLAN marad a történeti sorban.
    expect(p.legacyFills[0].fillPrice).toBe("95");
  });

  it("a nem pozitív sorokat kihagyja és jelöli, nem javítja fel", () => {
    const p = plan();
    expect(p.summary.skippedTrades).toBe(1);
    expect(p.warnings.some((w) => w.code === "zero_or_negative_amount" && w.tradeId === "t4")).toBe(true);
  });

  it("a `real` pontosságvesztés korlátja explicit figyelmeztetés", () => {
    expect(plan().warnings.some((w) => w.code === "real_precision_loss")).toBe(true);
  });

  it("determinisztikus: kétszeri tervezés azonos fill-kulcsokat ad (idempotens import)", () => {
    const a = plan();
    const b = plan();
    expect(a.legacyFills.map((f) => f.fillId)).toEqual(b.legacyFills.map((f) => f.fillId));
  });

  it("az összegzés a v1 sorokat tükrözi", () => {
    const p = plan();
    expect(p.summary.buyCount).toBe(2);
    expect(p.summary.sellCount).toBe(1);
    expect(p.summary.grossBuyQuote).toBe("5");
    expect(p.summary.grossSellQuote).toBe("4");
    expect(p.summary.feesQuote).toBe("0.009");
  });
});

describe("legacy-import — eltérésjelentés és túlsúly", () => {
  it("a diff megmutatja a nyitóállapot változását", () => {
    const rows = buildDiff({ cash: "0", positions: {} }, plan());
    const cash = rows.find((r) => r.key === "cash:USDT")!;
    expect(cash.before).toBe("0");
    expect(cash.after).toBe("0.09354296");
    expect(cash.delta).toBe("0.09354296");
    expect(rows.find((r) => r.key === "qty:BTC")!.after).toBe("0.001688317");
  });

  it("a túlsúlyt JELENTI, de a migráció nem ad el", () => {
    const over = detectOverweight(plan(), { BTC: "59000", ETH: "3000" }, "0.2");
    expect(over).toHaveLength(1);
    expect(over[0].symbol).toBe("BTC");
    expect(Number(over[0].sharePct)).toBeGreaterThan(0.9);
  });

  it("ár nélkül nincs kitalált túlsúly-szám", () => {
    expect(detectOverweight(plan(), {}, "0.2")).toEqual([]);
  });

  it("az összefoglaló emberi olvasásra alkalmas és tartalmazza az epochot", () => {
    const text = formatPlanSummary(plan());
    expect(text).toContain("v2-2026-09-05");
    expect(text).toContain("Történeti sorok");
    expect(text).toMatch(/Nyitó készpénz/);
  });
});

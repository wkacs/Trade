import { describe, it, expect } from "vitest";
import { buildAuditReport, type AuditRawState } from "../../scripts/audit-state";

const fixture: AuditRawState = {
  portfolios: [
    {
      id: "11111111-2222-3333-4444-555555555555",
      initialCapitalUsd: 100,
      cashUsd: 0.09354296,
      mode: "paper",
      createdAt: "2026-06-26T10:00:00.000Z",
    },
  ],
  openPositions: [
    { symbol: "BTC", qty: 0.001688317, entryPrice: 59000, stopPrice: 56050 },
    { symbol: "ETH", qty: 0.000008429329, entryPrice: 3000, stopPrice: 2850 },
  ],
  trades: [
    { side: "BUY", origin: "ai", mode: "paper", amountUsd: 2, feeUsd: 0.002, executedAt: "2026-07-01T00:00:00.000Z" },
    { side: "BUY", origin: null, mode: "paper", amountUsd: 3, feeUsd: 0.003, executedAt: "2026-07-02T00:00:00.000Z" },
    { side: "SELL", origin: "stop-loss", mode: "paper", amountUsd: 4, feeUsd: 0.004, executedAt: "2026-07-03T00:00:00.000Z" },
  ],
  decisionCount: 178,
  lastDecisionTs: "2026-07-21T09:35:00.000Z",
  tickRunCount: 400,
};

describe("audit-state / buildAuditReport", () => {
  it("összesíti a trade-eket oldal, eredet és mód szerint", () => {
    const r = buildAuditReport(fixture, "2026-09-05T12:00:00.000Z");
    expect(r.trades.total).toBe(3);
    expect(r.trades.buys).toBe(2);
    expect(r.trades.sells).toBe(1);
    expect(r.trades.byOrigin).toEqual({ ai: 1, unknown: 1, "stop-loss": 1 });
    expect(r.trades.byMode).toEqual({ paper: 3 });
    expect(r.trades.grossBuyUsd).toBeCloseTo(5, 10);
    expect(r.trades.grossSellUsd).toBeCloseTo(4, 10);
    expect(r.trades.feesUsd).toBeCloseTo(0.009, 10);
    expect(r.trades.firstExecutedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(r.trades.lastExecutedAt).toBe("2026-07-03T00:00:00.000Z");
  });

  it("redaktál: a teljes portfolio-UUID nem kerül a jelentésbe", () => {
    const r = buildAuditReport(fixture, "2026-09-05T12:00:00.000Z");
    const json = JSON.stringify(r);
    expect(json).not.toContain("11111111-2222-3333-4444-555555555555");
    expect(r.portfolios[0].idPrefix).toBe("11111111");
    expect(r.redacted.length).toBeGreaterThan(0);
  });

  it("a nyitott pozíciókat belépési értékkel adja vissza", () => {
    const r = buildAuditReport(fixture, "2026-09-05T12:00:00.000Z");
    expect(r.openPositions).toHaveLength(2);
    expect(r.openPositions[0].valueAtEntryUsd).toBeCloseTo(0.001688317 * 59000, 8);
  });

  it("az injektált időt használja, nem a rendszerórát", () => {
    expect(buildAuditReport(fixture, "2020-01-01T00:00:00.000Z").generatedAtIso).toBe(
      "2020-01-01T00:00:00.000Z",
    );
  });
});

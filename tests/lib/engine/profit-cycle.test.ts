import { describe, it, expect } from "vitest";
import { planProfitCycle } from "@/lib/engine/profit-cycle";

const baseInput = {
  positions: [{ id: "p1", symbol: "BTC", qty: 0.01, entryPrice: 60000, stopPrice: 57000 }],
  candles: { BTC: { low: 56000, high: 61000, close: 58000 } }, // low ≤ stop 57000 → stop tüzel
  fearGreedValue: 50,
  coinChanges: [{ symbol: "BTC", change24hPct: -2 }],
  weeklyBudgetRemainingUsd: 1000,
  totalEquity: 10000,
  stopLossPct: 0.05,
};

describe("planProfitCycle", () => {
  it("stop-loss order, ha a low átszúrja a stopot", () => {
    const plan = planProfitCycle(baseInput);
    const stop = plan.orders.find((o) => o.kind === "stop-loss");
    expect(stop).toBeDefined();
    expect(stop!.side).toBe("SELL");
    expect(stop!.qty).toBeCloseTo(0.01, 9);
    expect(stop!.triggerPrice).toBe(57000);
  });

  it("ratchet stop-update emelkedő árnál (close-alapú, nincs look-ahead)", () => {
    const plan = planProfitCycle({
      ...baseInput,
      positions: [{ id: "p1", symbol: "BTC", qty: 0.01, entryPrice: 60000, stopPrice: 57000 }],
      candles: { BTC: { low: 64000, high: 66000, close: 65000 } }, // nem tüzel; close 65000 → új stop 61750
    });
    const upd = plan.stopUpdates.find((u) => u.positionId === "p1");
    expect(upd).toBeDefined();
    expect(upd!.newStop).toBeCloseTo(61750, 0); // 65000 * 0.95
    expect(plan.orders.find((o) => o.kind === "stop-loss")).toBeUndefined();
  });

  it("DCA BUY, ha F&G ≤ küszöb és van keret", () => {
    const plan = planProfitCycle({
      ...baseInput,
      candles: { BTC: { low: 59000, high: 61000, close: 60000 } }, // nem tüzel a stop
      fearGreedValue: 20, // ≤ 25
    });
    const dca = plan.orders.find((o) => o.kind === "dca");
    expect(dca).toBeDefined();
    expect(dca!.side).toBe("BUY");
    expect(dca!.amountUsd).toBeCloseTo(10000 * 0.02, 6); // dcaBuyPct
  });

  it("nincs DCA, ha a heti keret elfogyott", () => {
    const plan = planProfitCycle({
      ...baseInput,
      candles: { BTC: { low: 59000, high: 61000, close: 60000 } },
      fearGreedValue: 20,
      weeklyBudgetRemainingUsd: 0,
    });
    expect(plan.orders.find((o) => o.kind === "dca")).toBeUndefined();
  });
});

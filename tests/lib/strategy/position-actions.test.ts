import { describe, it, expect } from "vitest";
import { evaluatePosition, type PositionWithPrice } from "@/lib/strategy/position-actions";

// Degenerált band (mint élesben): low=high=close=ár.
const at = (price: number) => ({ low: price, high: price, close: price });

const pos = (over: Partial<PositionWithPrice>): PositionWithPrice => ({
  positionId: "pos-1",
  symbol: "BTC",
  qty: 0.01,
  entryPrice: 60000,
  stopPrice: 57000, // -5%
  low: 60000,
  high: 60000,
  close: 60000,
  ...over,
});

describe("evaluatePosition — kód-alapú stop-loss + take-profit (candle-aware)", () => {
  it("low ≤ stopPrice → stop-loss, teljes SELL (qtyFraction 1.0)", () => {
    const action = evaluatePosition(pos({ ...at(57000) }));
    expect(action.kind).toBe("stop-loss");
    expect(action).toMatchObject({ side: "SELL", qtyFraction: 1.0 });
    if (action.kind === "stop-loss") expect(action.triggerPrice).toBe(57000);
  });

  it("ár a stop alatt → stop-loss", () => {
    const action = evaluatePosition(pos({ ...at(56000) }));
    expect(action.kind).toBe("stop-loss");
  });

  it("+15% nyereség (high) → take-profit, a pozíció FELE (qtyFraction 0.5)", () => {
    const action = evaluatePosition(pos({ entryPrice: 60000, ...at(69000) })); // +15%
    expect(action.kind).toBe("take-profit");
    expect(action).toMatchObject({ side: "SELL", qtyFraction: 0.5 });
    if (action.kind === "take-profit") expect(action.triggerPrice).toBeCloseTo(69000, 6); // entry*1.15
  });

  it("+18% nyereség → take-profit", () => {
    const action = evaluatePosition(pos({ entryPrice: 60000, ...at(70800) })); // +18%
    expect(action.kind).toBe("take-profit");
  });

  it("ha stop ÉS take-profit is fennáll → stop-loss elsőbbség", () => {
    const action = evaluatePosition(pos({ entryPrice: 60000, ...at(70000), stopPrice: 71000 }));
    expect(action.kind).toBe("stop-loss");
  });

  it("+14.9% még nem ér el take-profitot → none", () => {
    const action = evaluatePosition(pos({ entryPrice: 60000, ...at(68940) })); // +14.9%
    expect(action.kind).toBe("none");
  });

  it("stop felett, profit alatt → none", () => {
    const action = evaluatePosition(pos({ entryPrice: 60000, ...at(61000) }));
    expect(action.kind).toBe("none");
  });

  // ── Intra-candle esetek (a backtest realizmus lényege) ──
  it("stop a gyertya LOW-jára tüzel, close a stop FÖLÖTT is", () => {
    const a = evaluatePosition(pos({ entryPrice: 100, stopPrice: 95, low: 94, high: 101, close: 99 }));
    expect(a.kind).toBe("stop-loss");
    if (a.kind === "stop-loss") expect(a.triggerPrice).toBe(95);
  });

  it("take-profit a gyertya HIGH-jára tüzel (intra-candle)", () => {
    const a = evaluatePosition(pos({ entryPrice: 100, stopPrice: 95, low: 100, high: 116, close: 105 }));
    expect(a.kind).toBe("take-profit");
    if (a.kind === "take-profit") expect(a.triggerPrice).toBeCloseTo(115, 6); // entry*(1+0.15)
  });

  it("stop ÉS TP egy gyertyán → a STOP nyer (konzervatív)", () => {
    const a = evaluatePosition(pos({ entryPrice: 100, stopPrice: 96, low: 95, high: 116, close: 100 }));
    expect(a.kind).toBe("stop-loss");
  });
});

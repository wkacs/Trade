import { describe, it, expect } from "vitest";
import { evaluatePosition, type PositionWithPrice } from "@/lib/strategy/position-actions";

const pos = (over: Partial<PositionWithPrice>): PositionWithPrice => ({
  positionId: "pos-1",
  symbol: "BTC",
  qty: 0.01,
  entryPrice: 60000,
  stopPrice: 57000, // -5%
  currentPrice: 60000,
  ...over,
});

describe("evaluatePosition — kód-alapú stop-loss + take-profit", () => {
  it("currentPrice ≤ stopPrice → stop-loss, teljes SELL (qtyFraction 1.0)", () => {
    const action = evaluatePosition(pos({ currentPrice: 57000 }));
    expect(action.kind).toBe("stop-loss");
    expect(action).toMatchObject({ side: "SELL", qtyFraction: 1.0 });
  });

  it("currentPrice a stop alatt → stop-loss", () => {
    const action = evaluatePosition(pos({ currentPrice: 56000 }));
    expect(action.kind).toBe("stop-loss");
  });

  it("+15% nyereség → take-profit, a pozíció FELE (qtyFraction 0.5)", () => {
    const action = evaluatePosition(pos({ entryPrice: 60000, currentPrice: 69000 })); // +15%
    expect(action.kind).toBe("take-profit");
    expect(action).toMatchObject({ side: "SELL", qtyFraction: 0.5 });
  });

  it("+18% nyereség → take-profit", () => {
    const action = evaluatePosition(pos({ entryPrice: 60000, currentPrice: 70800 })); // +18%
    expect(action.kind).toBe("take-profit");
  });

  it("ha stop ÉS take-profit is fennáll → stop-loss elsőbbség", () => {
    // entry 60000, currentPrice 70000 lenne +16% (take-profit), de a stopPrice 71000,
    // tehát a current ≤ stop is igaz → a stop-loss nyer.
    const action = evaluatePosition(pos({ entryPrice: 60000, currentPrice: 70000, stopPrice: 71000 }));
    expect(action.kind).toBe("stop-loss");
  });

  it("+14.9% még nem ér el take-profitot → none", () => {
    const action = evaluatePosition(pos({ entryPrice: 60000, currentPrice: 68940 })); // +14.9%
    expect(action.kind).toBe("none");
  });

  it("stop felett, profit alatt → none", () => {
    const action = evaluatePosition(pos({ entryPrice: 60000, currentPrice: 61000 }));
    expect(action.kind).toBe("none");
  });
});

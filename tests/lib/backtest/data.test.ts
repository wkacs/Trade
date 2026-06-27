import { describe, it, expect } from "vitest";
import { alignFrames } from "@/lib/backtest/data";
import type { Candle } from "@/lib/backtest/types";

const c = (ts: number, close: number): Candle => ({ ts, open: close, high: close, low: close, close, volume: 1 });
const H = 3600_000;

describe("alignFrames", () => {
  it("órákra illeszt: minden óra-timestamp egy frame, a symbol-gyertyákkal", () => {
    const frames = alignFrames(
      { BTC: [c(0, 100), c(H, 101)], ETH: [c(0, 50), c(H, 51)] },
      new Map([
        [0, 20],
        [H, 22],
      ]),
    );
    expect(frames).toHaveLength(2);
    expect(frames[0].ts).toBe(0);
    expect(frames[0].candles.BTC.close).toBe(100);
    expect(frames[0].candles.ETH.close).toBe(50);
    expect(frames[0].fearGreedValue).toBe(20);
  });

  it("hiányzó symbol-gyertya: a frame csak a meglévőt tartalmazza", () => {
    const frames = alignFrames({ BTC: [c(0, 100)], ETH: [c(H, 51)] }, new Map());
    const byTs = Object.fromEntries(frames.map((f) => [f.ts, f]));
    expect(byTs[0].candles.BTC).toBeDefined();
    expect(byTs[0].candles.ETH).toBeUndefined();
    expect(byTs[0].fearGreedValue).toBeNull();
  });

  it("a Fear&Greed a legközelebbi NEM-jövőbeli napi értékre esik (forward-fill)", () => {
    // F&G napi; a 0-ás órára a 0-ás F&G, az 5*H órára is a 0-ás (nincs újabb).
    const frames = alignFrames({ BTC: [c(0, 100), c(5 * H, 100)] }, new Map([[0, 30]]));
    const byTs = Object.fromEntries(frames.map((f) => [f.ts, f]));
    expect(byTs[5 * H].fearGreedValue).toBe(30);
  });
});

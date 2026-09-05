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

// ── T12: lezárt gyertyák, rések és hibák a történelmi betöltésben ──────────────
import { loadHistory } from "@/lib/backtest/data";

const HOUR2 = 3600_000;
const NOW2 = Date.UTC(2026, 8, 5, 12, 0, 0);
const kline2 = (openTime: number, close: number) => [
  openTime,
  String(close),
  String(close + 1),
  String(close - 1),
  String(close),
  "10",
  openTime + HOUR2 - 1,
  "1000",
  5,
];

describe("loadHistory — adatminőség (T12)", () => {
  it("a FUTÓ gyertya nem kerül be a történelmi sorozatba", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("fng")) return { ok: true, json: async () => ({ data: [] }) } as any;
      return {
        ok: true,
        status: 200,
        json: async () => [kline2(NOW2 - 2 * HOUR2, 100), kline2(NOW2 - 1, 101)],
      } as any;
    }) as unknown as typeof fetch;

    const { frames, quality } = await loadHistory(["BTC"], 1, { now: () => NOW2, fetchImpl });
    expect(frames).toHaveLength(1);
    expect(quality.bySymbol.BTC.droppedUnclosed).toBe(1);
  });

  it("a rés jelentésbe kerül és degraded állapotot jelez", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("fng")) return { ok: true, json: async () => ({ data: [] }) } as any;
      return {
        ok: true,
        status: 200,
        json: async () => [kline2(NOW2 - 5 * HOUR2, 100), kline2(NOW2 - 2 * HOUR2, 102)],
      } as any;
    }) as unknown as typeof fetch;

    const { quality } = await loadHistory(["BTC"], 1, { now: () => NOW2, fetchImpl });
    expect(quality.bySymbol.BTC.gaps).toBe(1);
    expect(quality.degraded).toBe(true);
  });

  it("a rate limit STRUKTURÁLT hibaként látszik, nem néma üres sorozat", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("fng")) return { ok: true, json: async () => ({ data: [] }) } as any;
      return { ok: false, status: 429 } as any;
    }) as unknown as typeof fetch;

    const { frames, quality } = await loadHistory(["BTC"], 1, { now: () => NOW2, fetchImpl });
    expect(frames).toHaveLength(0);
    expect(quality.bySymbol.BTC.error).toMatch(/rate_limited/);
    expect(quality.degraded).toBe(true);
  });
});

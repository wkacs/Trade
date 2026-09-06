import { describe, it, expect } from "vitest";
import { collectAll, type DataCollector } from "@/lib/collectors/base";
import type { DataPoint } from "@/lib/types";

describe("collectAll", () => {
  it("üres lista esetén üres eredményt ad", async () => {
    const result = await collectAll([]);
    expect(result).toEqual([]);
  });

  it("több collector eredményét egyesíti", async () => {
    const fakeCollector: DataCollector = {
      name: "fake",
      collect: async () => [
        { source: "coingecko", symbol: "BTC", timestamp: 1, kind: "price", price: { usd: 100, volume24h: 1, change24hPct: 0 } },
      ],
    };
    const result = await collectAll([fakeCollector]);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("BTC");
  });

  it("egy collector hibája nem dönti romba a többit", async () => {
    const good: DataCollector = {
      name: "good",
      collect: async () => [
        { source: "coingecko", symbol: "ETH", timestamp: 1, kind: "price", price: { usd: 50, volume24h: 1, change24hPct: 0 } },
      ],
    };
    const bad: DataCollector = {
      name: "bad",
      collect: async () => {
        throw new Error("api down");
      },
    };
    const result = await collectAll([good, bad]);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("ETH");
  });

  it("DataPoint típus konzisztens", () => {
    const dp: DataPoint = { source: "rss", symbol: "BTC", timestamp: 1, kind: "rss" };
    expect(dp.kind).toBe("rss");
  });
});

// ── T14: egyenkénti időkorlát és mérhető részleges hiba ─────────────────────
import { collectAllWithOutcomes } from "@/lib/collectors/base";

describe("collectAllWithOutcomes — egy lassú forrás nem foghatja meg a ciklust", () => {
  const point = (symbol: string): DataPoint => ({
    source: "coingecko",
    symbol,
    timestamp: 1,
    kind: "price",
    price: { usd: 1, volume24h: 1, change24hPct: 0 },
  });

  it("időtúllépő collector hibaként látszik, a többi eredménye megmarad", async () => {
    const slow = { name: "lassu", collect: () => new Promise<DataPoint[]>(() => {}) };
    const fast = { name: "gyors", collect: async () => [point("BTC")] };
    const r = await collectAllWithOutcomes([slow, fast], { timeoutMs: 20 });
    expect(r.points).toHaveLength(1);
    expect(r.degraded).toBe(true);
    const slowOutcome = r.outcomes.find((o) => o.name === "lassu")!;
    expect(slowOutcome.ok).toBe(false);
    expect(slowOutcome.error).toMatch(/időtúllépés/);
  });

  it("minden collector kimenetele mérhető (pontszám és időtartam)", async () => {
    const a = { name: "a", collect: async () => [point("BTC"), point("ETH")] };
    const b = { name: "b", collect: async () => [] };
    const r = await collectAllWithOutcomes([a, b]);
    expect(r.degraded).toBe(false);
    expect(r.outcomes.map((o) => ({ name: o.name, ok: o.ok, points: o.points }))).toEqual([
      { name: "a", ok: true, points: 2 },
      { name: "b", ok: true, points: 0 },
    ]);
  });

  it("dobó collector nem dönti romba a ciklust", async () => {
    const bad = { name: "rossz", collect: async () => { throw new Error("boom"); } };
    const good = { name: "jo", collect: async () => [point("SOL")] };
    const r = await collectAllWithOutcomes([bad, good]);
    expect(r.points).toHaveLength(1);
    expect(r.outcomes.find((o) => o.name === "rossz")!.error).toMatch(/boom/);
  });
});

describe("collectAllWithOutcomes — a néma forrás-hiba láthatóvá tétele", () => {
  it("ok:false, ha a collector strukturált hibát jelent, akkor is, ha nem dobott", async () => {
    const silent: DataCollector = {
      name: "binance",
      collect: async () => [],
      lastError: () => "http_error — HTTP 451",
    };
    const r = await collectAllWithOutcomes([silent]);
    expect(r.outcomes[0].ok).toBe(false);
    expect(r.outcomes[0].error).toContain("451");
    expect(r.degraded).toBe(true);
  });

  it("a részleges hiba is látszik: a pontok megmaradnak, de a forrás nem ok", async () => {
    const partial: DataCollector = {
      name: "binance",
      collect: async () => [
        { source: "binance", symbol: "BTC", timestamp: 1, kind: "price", price: { usd: 1, volume24h: 1, change24hPct: 0 } },
      ],
      lastError: () => "ETH: network — fetch failed",
    };
    const r = await collectAllWithOutcomes([partial]);
    expect(r.points).toHaveLength(1);
    expect(r.outcomes[0].ok).toBe(false);
    expect(r.outcomes[0].error).toContain("ETH");
  });

  it("hibátlan collectornál nincs error és nem degraded", async () => {
    const fine: DataCollector = {
      name: "rss",
      collect: async () => [],
      lastError: () => null,
    };
    const r = await collectAllWithOutcomes([fine]);
    expect(r.outcomes[0].ok).toBe(true);
    expect(r.outcomes[0].error).toBeUndefined();
    expect(r.degraded).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  rawRank,
  riskAdjustedRank,
  rsRiskAdjustedRank,
  MOMENTUM_RANKINGS,
  resolveMomentumRanking,
} from "@/lib/strategy/momentum-ranking";

describe("momentum-ranking – rawRank", () => {
  it("a nyers periódus-változást adja vissza (a mai viselkedés)", () => {
    expect(rawRank({ symbol: "AAPL", change24hPct: 3.2 })).toBe(3.2);
  });
});

describe("momentum-ranking – riskAdjustedRank", () => {
  it("a változást a papír SAJÁT volatilitásával normalizálja", () => {
    expect(riskAdjustedRank({ symbol: "AAPL", change24hPct: 3, atrPct: 1 })).toBe(3);
    expect(riskAdjustedRank({ symbol: "COIN", change24hPct: 6, atrPct: 8 })).toBeCloseTo(0.75, 10);
  });

  it("a nagyobb nyers kiugrás VESZÍT a nyugodtabb papírral szemben", () => {
    const calm = riskAdjustedRank({ symbol: "AAPL", change24hPct: 3, atrPct: 1 });
    const wild = riskAdjustedRank({ symbol: "COIN", change24hPct: 6, atrPct: 8 });
    expect(calm).toBeGreaterThan(wild);
  });

  it("ismeretlen vagy nulla ATR → utolsó hely (NEM esik vissza nyers százalékra)", () => {
    expect(riskAdjustedRank({ symbol: "X", change24hPct: 99 })).toBe(Number.NEGATIVE_INFINITY);
    expect(riskAdjustedRank({ symbol: "X", change24hPct: 99, atrPct: 0 })).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("momentum-ranking – rsRiskAdjustedRank", () => {
  it("a relatív erőt is a volatilitással osztja", () => {
    expect(rsRiskAdjustedRank({ symbol: "AAPL", change24hPct: 3, benchmarkChangePct: 1, atrPct: 2 })).toBeCloseTo(1, 10);
  });

  it("ATR nélkül utolsó hely", () => {
    expect(rsRiskAdjustedRank({ symbol: "AAPL", change24hPct: 3, benchmarkChangePct: 1 })).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });
});

describe("momentum-ranking – névtár", () => {
  it("a 'raw' PONTOSAN a mai rangsor (nyers változás)", () => {
    expect(MOMENTUM_RANKINGS.raw).toBe(rawRank);
  });

  it("ismert nevet felold", () => {
    expect(resolveMomentumRanking("risk-adjusted")).toBe(riskAdjustedRank);
    expect(resolveMomentumRanking("rs-risk-adjusted")).toBe(rsRiskAdjustedRank);
  });

  it("önálló relatív-erő rangsor NINCS (konstans eltolás nem rendez át)", () => {
    expect(resolveMomentumRanking("rs")).toBeNull();
  });

  it("üres vagy ismeretlen név → null (némán NEM vált rangsort)", () => {
    expect(resolveMomentumRanking("")).toBeNull();
    expect(resolveMomentumRanking("   ")).toBeNull();
    expect(resolveMomentumRanking("nincs-ilyen")).toBeNull();
  });
});

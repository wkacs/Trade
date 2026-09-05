import { describe, it, expect } from "vitest";
import {
  applyRisk,
  evaluateOrder,
  positionHeadroom,
  riskContextFromLedger,
  originBudgetFor,
  DEFAULT_ORDER_RISK_PARAMS,
  type RiskContext,
  type OrderRiskContext,
} from "@/lib/risk/risk-manager";
import type { RawDecision } from "@/lib/types";
import { emptyLedger, type LedgerState } from "@/lib/portfolio/ledger";

// Mai default kockázati limitek (parity).
const RP = { maxPositionPct: 0.2, maxConcurrentPositions: 3, dailyLossCircuitBreakerPct: 0.03 };

const ctx = (
  cash: number,
  positions: { symbol: string; valueUsd: number }[] = [],
  dayPnlPct = 0,
  extra: Partial<RiskContext> = {},
): RiskContext => ({
  cashUsd: cash,
  positions,
  totalEquity: () => cash + positions.reduce((s, p) => s + p.valueUsd, 0),
  dayPnlPct,
  ...extra,
});

const buy = (symbol: string, amountPct: number, confidence = 0.8): RawDecision => ({
  action: "BUY",
  symbol,
  amountPct,
  confidence,
  reasoning: "x",
  model: "glm-5.2",
});

const sell = (symbol: string, amountPct: number): RawDecision => ({
  action: "SELL",
  symbol,
  amountPct,
  confidence: 0.8,
  reasoning: "x",
  model: "glm-5.2",
});

describe("applyRisk — kockázati limitek", () => {
  it("HOLD átmegy változatlanul", () => {
    const raw: RawDecision = { action: "HOLD", symbol: "BTC", amountPct: 0, confidence: 0.5, reasoning: "x", model: "glm-5.2" };
    const result = applyRisk(raw, ctx(10000), RP);
    expect(result.action).toBe("HOLD");
    expect(result.overridden).toBe(false);
  });

  it("20% feletti pozíciót visszavágja 20%-ra", () => {
    const result = applyRisk(buy("BTC", 0.5), ctx(10000), RP);
    expect(result.amountPct).toBeCloseTo(0.2, 12);
    expect(result.overridden).toBe(true);
    expect(result.overrideReason).toMatch(/20%/);
  });

  it("pont 20% megengedett", () => {
    const result = applyRisk(buy("BTC", 0.2), ctx(10000), RP);
    expect(result.amountPct).toBeCloseTo(0.2, 12);
    expect(result.overridden).toBe(false);
  });

  it("ha már 3 KÜLÖNBÖZŐ pozíció van és ÚJ coinra BUY jön → HOLD", () => {
    const positions = [
      { symbol: "BTC", valueUsd: 1000 },
      { symbol: "ETH", valueUsd: 1000 },
      { symbol: "SOL", valueUsd: 1000 },
    ];
    const result = applyRisk(buy("ADA", 0.1), ctx(7000, positions), RP);
    expect(result.action).toBe("HOLD");
    expect(result.overridden).toBe(true);
    expect(result.overrideReason).toMatch(/pozíció/i);
  });

  it("már nyitott coinra BUY nem számít új pozíciónak (átenged)", () => {
    const positions = [
      { symbol: "BTC", valueUsd: 1000 },
      { symbol: "ETH", valueUsd: 1000 },
      { symbol: "SOL", valueUsd: 1000 },
    ];
    const result = applyRisk(buy("BTC", 0.1), ctx(7000, positions), RP);
    expect(result.action).toBe("BUY");
    expect(result.overridden).toBe(false);
  });

  it("napi -3% circuit breaker HOLD-onlyvá tesz", () => {
    const result = applyRisk(buy("BTC", 0.1), ctx(9700, [], -0.031), RP);
    expect(result.action).toBe("HOLD");
    expect(result.overridden).toBe(true);
    expect(result.overrideReason).toMatch(/circuit breaker|napi/i);
  });

  it("-2.9% még nem aktiválja a breakert", () => {
    const result = applyRisk(buy("BTC", 0.1), ctx(9710, [], -0.029), RP);
    expect(result.action).toBe("BUY");
    expect(result.overridden).toBe(false);
  });

  it("döntés kap egy id-t és timestampet", () => {
    const result = applyRisk(buy("BTC", 0.1), ctx(10000), RP);
    expect(result.id).toBeTruthy();
    expect(result.timestamp).toBeGreaterThan(0);
  });
});

describe("applyRisk — az auditban bizonyított hibák regressziója", () => {
  it("AUDIT §1: 100 equity, 20 USD BTC, 80 cash, 20%-os BUY → NINCS további vétel", () => {
    const result = applyRisk(buy("BTC", 0.2), ctx(80, [{ symbol: "BTC", valueUsd: 20 }]), RP);
    // equity*0.2 = 20, meglévő 20 → szabad keret 0.
    expect(result.action).toBe("HOLD");
    expect(result.amountPct).toBe(0);
    expect(result.overridden).toBe(true);
  });

  it("AUDIT §1: a nagy BUY visszavágása NEM ugorja át a pozíciószám-korlátot", () => {
    const positions = [
      { symbol: "BTC", valueUsd: 1000 },
      { symbol: "ETH", valueUsd: 1000 },
      { symbol: "SOL", valueUsd: 1000 },
    ];
    // A régi kód a 0.5 → 0.2 visszavágás után AZONNAL visszatért, így az ADA átment.
    const result = applyRisk(buy("ADA", 0.5), ctx(7000, positions), RP);
    expect(result.action).toBe("HOLD");
    expect(result.overrideReason).toMatch(/pozíció/i);
  });

  it("AUDIT §4: a napi veszteségkapu NEM tiltja az eladást", () => {
    const result = applyRisk(sell("BTC", 1), ctx(0, [{ symbol: "BTC", valueUsd: 50 }], -0.09), RP);
    expect(result.action).toBe("SELL");
    expect(result.amountPct).toBe(1);
  });

  it("AUDIT §2: az eladás cash=0 mellett is átmegy (nem a készpénz a méret alapja)", () => {
    const result = applyRisk(sell("BTC", 0.5), ctx(0, [{ symbol: "BTC", valueUsd: 99 }]), RP);
    expect(result.action).toBe("SELL");
    expect(result.amountPct).toBe(0.5);
  });

  it("nem birtokolt coin eladása HOLD-ra vált (orphan SELL tiltva)", () => {
    const result = applyRisk(sell("ETH", 1), ctx(100, [{ symbol: "BTC", valueUsd: 50 }]), RP);
    expect(result.action).toBe("HOLD");
  });

  it("a latch a nap végéig tilt, akkor is, ha a dayPnlPct visszakúszott", () => {
    const result = applyRisk(buy("BTC", 0.1), ctx(10000, [], 0.01, { dailyLossLatched: true }), RP);
    expect(result.action).toBe("HOLD");
    expect(result.overrideReason).toMatch(/latch|veszteségkapu/i);
  });

  it("hiányzó napkezdő referencia mellett az új vétel szünetel", () => {
    const result = applyRisk(buy("BTC", 0.1), ctx(10000, [], 0, { dayBaselineMissing: true }), RP);
    expect(result.action).toBe("HOLD");
    expect(result.overrideReason).toMatch(/napkezdő/i);
  });

  it("a foglalás is fogyasztja a szabad keretet", () => {
    const result = applyRisk(
      buy("BTC", 0.2),
      ctx(100, [], 0, { reservedQuoteBySymbol: { BTC: 20 } }),
      RP,
    );
    expect(result.action).toBe("HOLD");
  });

  it("a kosáron kívüli coin nem vehető", () => {
    const result = applyRisk(buy("DOGE", 0.1), ctx(100, [], 0, { allowedSymbols: ["BTC", "ETH", "SOL"] }), RP);
    expect(result.action).toBe("HOLD");
  });
});

describe("applyRisk — a heti DCA-keret NEM gátolja az AI BUY-t (fagyás-fix)", () => {
  it("az AI BUY átmegy akkor is, ha a heti DCA-keret elfogyott", () => {
    const result = applyRisk(buy("BTC", 0.1), ctx(1000), RP);
    expect(result.action).toBe("BUY");
    expect(result.overridden).toBe(false);
  });

  it("a max-pozíció és circuit breaker továbbra is korlátoz", () => {
    expect(applyRisk(buy("BTC", 0.5), ctx(1000), RP).amountPct).toBeCloseTo(0.2, 12);
    expect(applyRisk(buy("BTC", 0.1), ctx(1000, [], -0.05), RP).action).toBe("HOLD");
  });

  it("az eredet-keret csak a DCA-ra vonatkozik", () => {
    expect(originBudgetFor("dca", { weeklyDcaRemaining: "5" })).toBe("5");
    expect(originBudgetFor("ai", { weeklyDcaRemaining: "5" })).toBeUndefined();
    expect(originBudgetFor("momentum", { weeklyDcaRemaining: "5" })).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Végrehajtás-szintű kapu
// ─────────────────────────────────────────────────────────────────────────────

function ledgerWith(cash: string, positions: Record<string, { qty: string; cost: string }> = {}): LedgerState {
  const base = emptyLedger("pf-1", "paper", cash);
  return {
    ...base,
    positions: Object.fromEntries(
      Object.entries(positions).map(([symbol, v]) => [
        symbol,
        { symbol, qty: v.qty, costBasisQuote: v.cost, stopPrice: null },
      ]),
    ),
  };
}

const orderCtx = (over: Partial<OrderRiskContext> & { ledger: LedgerState }): OrderRiskContext => ({
  prices: { BTC: "60000", ETH: "3000", SOL: "150" },
  reservedQuoteBySymbol: {},
  reservedQuoteTotal: "0",
  dailyLossLatched: false,
  dayBaselineMissing: false,
  allowedSymbols: ["BTC", "ETH", "SOL"],
  quoteAsset: "USDT",
  ...over,
});

describe("evaluateOrder — a hiteles kapu minden order előtt", () => {
  it("AUDIT §1 végrehajtási szinten: 20 USD BTC + 80 cash + 20% → nincs BUY", () => {
    // Pontos fixture: 1 db 20 USD-s egység = 20 USD pozícióérték, 80 USD készpénz.
    const ledger = ledgerWith("80", { BTC: { qty: "1", cost: "20" } });
    const v = evaluateOrder({ side: "BUY", symbol: "BTC", desiredQuote: "20" }, orderCtx({ ledger, prices: { BTC: "20" } }));
    expect(v.allowed).toBe(false);
    expect(!v.allowed && v.code).toBe("no_headroom");
  });

  it("a szabad keret a meglévő értéket ÉS a foglalást is levonja", () => {
    const ledger = ledgerWith("100");
    const h = positionHeadroom("BTC", orderCtx({ ledger, reservedQuoteBySymbol: { BTC: "5" } }), DEFAULT_ORDER_RISK_PARAMS);
    expect(h.equity).toBe("100");
    expect(h.headroom).toBe("15");
  });

  it("a kapu vág, de nem tesz nagyobbá", () => {
    const ledger = ledgerWith("100");
    const v = evaluateOrder({ side: "BUY", symbol: "BTC", desiredQuote: "50" }, orderCtx({ ledger }));
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    expect(v.order.side === "BUY" && v.order.maxQuoteSpend).toBe("20");
    expect(v.adjusted).toBe(true);
  });

  it("a készpénz-korlát díjtartalékkal számol (nincs fedezethiányos fill)", () => {
    const ledger = ledgerWith("10");
    const v = evaluateOrder({ side: "BUY", symbol: "BTC", desiredQuote: "10" }, orderCtx({ ledger }));
    expect(v.allowed).toBe(true);
    if (!v.allowed || v.order.side !== "BUY") return;
    // equity 10 → pozíciólimit 2; ez a szűkebb korlát.
    expect(v.order.maxQuoteSpend).toBe("2");
  });

  it("az összes aktív foglalás csökkenti a szabad készpénzt", () => {
    const ledger = ledgerWith("100");
    const v = evaluateOrder(
      { side: "BUY", symbol: "BTC", desiredQuote: "20" },
      orderCtx({ ledger, reservedQuoteTotal: "95" }),
    );
    expect(v.allowed).toBe(true);
    if (!v.allowed || v.order.side !== "BUY") return;
    expect(Number(v.order.maxQuoteSpend)).toBeCloseTo(5 / 1.001, 9);
  });

  it("a minimum kötésérték alatt nincs order", () => {
    const ledger = ledgerWith("2");
    const v = evaluateOrder({ side: "BUY", symbol: "BTC", desiredQuote: "2" }, orderCtx({ ledger }));
    expect(v.allowed).toBe(false);
    expect(!v.allowed && v.code).toBe("below_min_notional");
  });

  it("az eredet-keret (heti DCA-maradék) vág", () => {
    const ledger = ledgerWith("100");
    const v = evaluateOrder(
      { side: "BUY", symbol: "BTC", desiredQuote: "20" },
      orderCtx({ ledger, originBudgetQuote: "3" }),
    );
    expect(v.allowed && v.order.side === "BUY" && v.order.maxQuoteSpend).toBe("3");
  });

  it("elfogyott eredet-keret esetén nincs order", () => {
    const ledger = ledgerWith("100");
    const v = evaluateOrder(
      { side: "BUY", symbol: "BTC", desiredQuote: "20" },
      orderCtx({ ledger, originBudgetQuote: "0" }),
    );
    expect(v.allowed).toBe(false);
    expect(!v.allowed && v.code).toBe("origin_budget_exhausted");
  });

  it("SELL cash=0 mellett is végrehajtható és a napi kapunál is engedett", () => {
    const ledger = ledgerWith("0", { BTC: { qty: "0.001", cost: "60" } });
    const v = evaluateOrder(
      { side: "SELL", symbol: "BTC", baseQty: "0.001" },
      orderCtx({ ledger, dailyLossLatched: true }),
    );
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.order.side === "SELL" && v.order.baseQty).toBe("0.001");
  });

  it("a túlméretes SELL a birtokoltra vágódik, a nem birtokolt tiltott", () => {
    const ledger = ledgerWith("0", { BTC: { qty: "0.001", cost: "60" } });
    const clamped = evaluateOrder({ side: "SELL", symbol: "BTC", baseQty: "5" }, orderCtx({ ledger }));
    expect(clamped.allowed && clamped.order.side === "SELL" && clamped.order.baseQty).toBe("0.001");
    const orphan = evaluateOrder({ side: "SELL", symbol: "ETH", baseQty: "1" }, orderCtx({ ledger }));
    expect(orphan.allowed).toBe(false);
    expect(!orphan.allowed && orphan.code).toBe("no_position");
  });

  it("a napi latch és a hiányzó baseline tiltja a BUY-t", () => {
    const ledger = ledgerWith("100");
    expect(evaluateOrder({ side: "BUY", symbol: "BTC", desiredQuote: "10" }, orderCtx({ ledger, dailyLossLatched: true })).allowed).toBe(false);
    expect(evaluateOrder({ side: "BUY", symbol: "BTC", desiredQuote: "10" }, orderCtx({ ledger, dayBaselineMissing: true })).allowed).toBe(false);
  });

  it("a pozíciószám-korlát ÚJ coinra érvényes, meglévőre nem", () => {
    const ledger = ledgerWith("100", {
      BTC: { qty: "0.0001", cost: "6" },
      ETH: { qty: "0.001", cost: "3" },
      SOL: { qty: "0.01", cost: "1.5" },
    });
    const ctxWith = orderCtx({ ledger, allowedSymbols: ["BTC", "ETH", "SOL", "ADA"], prices: { BTC: "60000", ETH: "3000", SOL: "150", ADA: "1" } });
    const fresh = evaluateOrder({ side: "BUY", symbol: "ADA", desiredQuote: "5" }, ctxWith);
    expect(fresh.allowed).toBe(false);
    expect(!fresh.allowed && fresh.code).toBe("max_positions");
    const existing = evaluateOrder({ side: "BUY", symbol: "BTC", desiredQuote: "5" }, ctxWith);
    expect(existing.allowed).toBe(true);
  });

  it("a kosáron kívüli szimbólum elutasításra kerül", () => {
    const ledger = ledgerWith("100");
    const v = evaluateOrder({ side: "BUY", symbol: "DOGE", desiredQuote: "5" }, orderCtx({ ledger }));
    expect(!v.allowed && v.code).toBe("symbol_not_allowed");
  });

  it("riskContextFromLedger mark-to-market értékeket ad a döntés-szintű kapunak", () => {
    const ledger = ledgerWith("80", { BTC: { qty: "0.001", cost: "50" } });
    const c = riskContextFromLedger(ledger, { BTC: "60000" });
    expect(c.cashUsd).toBe(80);
    expect(c.positions[0].valueUsd).toBe(60);
    expect(c.totalEquity()).toBe(140);
  });
});

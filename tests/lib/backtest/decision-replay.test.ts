import { describe, it, expect } from "vitest";
import {
  validateForReplay,
  replayDecisions,
  replayWithoutAi,
  compareAiValue,
  replayCoverage,
  type RecordedDecision,
} from "@/lib/backtest/decision-replay";
import { cashOf, positionQty } from "@/lib/portfolio/ledger";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
const NOW = T0 + 100 * HOUR;

const decision = (over: Partial<RecordedDecision> = {}): RecordedDecision => ({
  id: over.id ?? "d-1",
  ts: over.ts ?? T0,
  tickId: "2026-09-01-00",
  action: over.action ?? "BUY",
  symbol: over.symbol !== undefined ? over.symbol : "BTC",
  amountPct: over.amountPct ?? 0.1,
  confidence: 0.7,
  model: "glm-5.2",
  ref: over.ref !== undefined ? over.ref : { prices: { BTC: 100 }, intent: "BUY", intentSymbol: "BTC", intentAmountPct: 0.1 },
  schemaVersion: 2,
  recordedAt: over.recordedAt,
  llm: over.llm ?? { model: "glm-5.2", promptVersion: "p2", totalTokens: 1000, latencyMs: 200 },
});

const opts = {
  openingCashUsd: "1000",
  allowedSymbols: ["BTC", "ETH", "SOL"],
  nowMs: NOW,
  feePct: "0.001",
  slippageBps: 0,
  llmCostPer1kTokens: 0.001,
};

describe("validateForReplay — csak AKKOR rögzített döntés játszható vissza (T20)", () => {
  const v = (d: RecordedDecision) => validateForReplay(d, { nowMs: NOW, allowedSymbols: ["BTC", "ETH", "SOL"] });

  it("érvényes, időben rögzített döntés visszajátszható", () => {
    expect(v(decision()).ok).toBe(true);
  });

  it("JÖVŐBELI intent TILOS", () => {
    const r = v(decision({ ts: NOW + HOUR }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("future_intent");
  });

  it("döntéskori pillanatkép nélkül nem rekonstruálható", () => {
    const r = v(decision({ ref: null }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_ref");
  });

  it("UTÓLAG gyártott sor nem bizonyíték", () => {
    const r = v(decision({ recordedAt: T0 + 5 * HOUR }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("generated_after_the_fact");
  });

  it("hiányzó döntéskori ár esetén nem játszható vissza", () => {
    const r = v(decision({ ref: { prices: {}, intent: "BUY", intentSymbol: "BTC", intentAmountPct: 0.1 } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_price");
  });

  it("ismeretlen szimbólum elutasításra kerül", () => {
    const r = v(decision({ symbol: "DOGE" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown_symbol");
  });

  it("a lefedettség kódonként összesíthető", () => {
    const cov = replayCoverage(
      [decision(), decision({ id: "d-2", ts: NOW + HOUR }), decision({ id: "d-3", ref: null })],
      { nowMs: NOW, allowedSymbols: ["BTC"] },
    );
    expect(cov.total).toBe(3);
    expect(cov.replayable).toBe(1);
    expect(cov.byReason).toEqual({ future_intent: 1, missing_ref: 1 });
  });
});

describe("replayDecisions — a rögzített intentek a KÖZÖS kapun futnak", () => {
  it("egy BUY végrehajtódik a döntéskori áron", () => {
    const r = replayDecisions([decision()], opts);
    expect(r.executed).toBe(1);
    expect(Number(positionQty(r.ledger, "BTC"))).toBeGreaterThan(0);
    expect(Number(cashOf(r.ledger, "USDT"))).toBeLessThan(1000);
  });

  it("a nem visszajátszható döntések kódonként látszanak", () => {
    const r = replayDecisions([decision({ id: "a" }), decision({ id: "b", ts: NOW + HOUR })], opts);
    expect(r.executed).toBe(1);
    expect(r.skipped.future_intent).toBe(1);
    expect(r.skippedIds).toContainEqual({ id: "b", reason: "future_intent" });
  });

  it("a kockázati kapu itt is érvényes (a 20%-os limit felett nincs vétel)", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      decision({ id: `d-${i}`, ts: T0 + i * HOUR, amountPct: 0.2 }),
    );
    const r = replayDecisions(many, opts);
    // Az első vétel után a BTC eléri a limitet → a többi elutasításra kerül.
    expect(r.executed).toBeLessThan(5);
    expect(r.skipped.risk).toBeGreaterThan(0);
  });

  it("a SELL a birtokolt mennyiség hányada (cash-független)", () => {
    const buy = decision({ id: "b1", ts: T0, action: "BUY", amountPct: 0.2 });
    const sell = decision({
      id: "s1",
      ts: T0 + HOUR,
      action: "SELL",
      amountPct: 1,
      ref: { prices: { BTC: 120 }, intent: "SELL", intentSymbol: "BTC", intentAmountPct: 1 },
    });
    const r = replayDecisions([buy, sell], opts);
    expect(r.executed).toBe(2);
    expect(r.ledger.positions.BTC).toBeUndefined();
    // 100-on vett, 120-on adott el → több készpénz, mint induláskor (díjak után is).
    expect(Number(cashOf(r.ledger, "USDT"))).toBeGreaterThan(1000);
  });

  it("az AI-költség elszámolódik a tokenekből", () => {
    const r = replayDecisions([decision(), decision({ id: "d-2", ts: T0 + HOUR })], opts);
    expect(r.cost.calls).toBe(2);
    expect(r.cost.totalTokens).toBe(2000);
    expect(r.cost.llmCostUsd).toBeCloseTo(0.002, 9);
  });

  it("HOLD döntések nem mozgatnak semmit", () => {
    const r = replayDecisions(
      [decision({ action: "HOLD", symbol: null, ref: { prices: { BTC: 100 }, intent: "HOLD", intentSymbol: null, intentAmountPct: 0 } })],
      opts,
    );
    expect(r.executed).toBe(0);
    expect(cashOf(r.ledger, "USDT")).toBe("1000");
  });
});

describe("AI nélküli kontroll UGYANAZON a feltételrendszeren", () => {
  const decisions = [
    decision({ id: "b1", ts: T0, action: "BUY", amountPct: 0.2 }),
    decision({
      id: "s1",
      ts: T0 + HOUR,
      action: "SELL",
      amountPct: 1,
      ref: { prices: { BTC: 120 }, intent: "SELL", intentSymbol: "BTC", intentAmountPct: 1 },
    }),
  ];

  it("a kontroll egyetlen AI-intentet sem hajt végre", () => {
    const control = replayWithoutAi(decisions, opts);
    expect(control.executed).toBe(0);
    expect(control.endingEquityUsd).toBeCloseTo(1000, 6);
    expect(control.cost.llmCostUsd).toBe(0);
  });

  it("az AI hozzáadott értéke a KÜLÖNBSÉG, az AI-költség után", () => {
    const cmp = compareAiValue(decisions, opts, 1);
    expect(cmp.withAi.executed).toBe(2);
    expect(cmp.withoutAi.executed).toBe(0);
    expect(cmp.netAiValueUsd).toBeCloseTo(
      cmp.withAi.endingEquityUsd - cmp.withoutAi.endingEquityUsd - cmp.withAi.cost.llmCostUsd,
      9,
    );
  });

  it("kevés végrehajtott döntés → NEM ELDÖNTHETŐ, nem eredmény", () => {
    const cmp = compareAiValue(decisions, opts, 30);
    expect(cmp.inconclusive).toBe(true);
    expect(cmp.reason).toMatch(/NEM ELDÖNTHETŐ/);
  });
});

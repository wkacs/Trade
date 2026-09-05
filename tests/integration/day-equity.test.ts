import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { resolveDayGate, loadDayEquityRow, saveDayEquityRow, utcDayKey } from "@/lib/portfolio/day-equity";
import { resetSchema, truncateAll, testSql } from "./db-helpers";

/**
 * T07 — a napi kapu valódi PostgreSQL ellen.
 *
 * Amit bizonyít:
 *  - a (portfolio, mode, nap) hármas egyedi, így KÉT EGYIDEJŰ napnyitás sem hoz létre
 *    két baseline-t, és a második futó az elsőét használja;
 *  - a paper és a live számla NEM osztozik napi referencián;
 *  - a latch tartósan megmarad a nap végéig.
 */
describe("napi equity-referencia — valódi PostgreSQL", () => {
  const NOW = Date.UTC(2026, 8, 5, 3, 0, 0);
  const DAY = utcDayKey(NOW);

  beforeAll(async () => {
    await resetSchema();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  });

  it("két egyidejű napnyitás EGY baseline-t eredményez", async () => {
    const [a, b] = await Promise.all([
      resolveDayGate("pf", "paper", "100", "0.03", NOW),
      resolveDayGate("pf", "paper", "120", "0.03", NOW),
    ]);
    const rows = (await testSql()`SELECT count(*)::int AS c FROM daily_equity`) as { c: number }[];
    expect(rows[0].c).toBe(1);
    // Mindkét futó UGYANAZT a baseline-t látja (amelyik előbb ért oda).
    expect(a.row.baselineEquity).toBe(b.row.baselineEquity);
  });

  it("a paper és a live számla külön napi referenciát kap", async () => {
    await resolveDayGate("pf", "paper", "100", "0.03", NOW);
    await resolveDayGate("pf", "live", "500", "0.03", NOW);
    const paper = await loadDayEquityRow("pf", "paper", DAY);
    const live = await loadDayEquityRow("pf", "live", DAY);
    expect(paper?.baselineEquity).toBe("100");
    expect(live?.baselineEquity).toBe("500");
  });

  it("a latch tartósan megmarad, és a visszakúszó equity sem oldja fel", async () => {
    await resolveDayGate("pf", "paper", "100", "0.03", NOW);
    const breached = await resolveDayGate("pf", "paper", "96", "0.03", NOW + 3600_000);
    expect(breached.latched).toBe(true);

    const recovered = await resolveDayGate("pf", "paper", "105", "0.03", NOW + 7200_000);
    expect(recovered.latched).toBe(true);
    expect(recovered.blockNewBuys).toBe(true);

    const stored = await loadDayEquityRow("pf", "paper", DAY);
    expect(stored?.lossLatched).toBe(true);
    expect(stored?.latchedAt).not.toBeNull();
  });

  it("a baseline egy napon belül NEM íródik felül", async () => {
    await resolveDayGate("pf", "paper", "100", "0.03", NOW);
    await resolveDayGate("pf", "paper", "150", "0.03", NOW + 3600_000);
    const stored = await loadDayEquityRow("pf", "paper", DAY);
    expect(stored?.baselineEquity).toBe("100");
  });

  it("napváltáskor új sor készül, a tegnapi latch nem öröklődik", async () => {
    await saveDayEquityRow("pf", "paper", {
      dayUtc: utcDayKey(NOW - 24 * 3600_000),
      baselineEquity: "100",
      cashFlowQuote: "0",
      source: "day-open",
      lossLatched: true,
      latchedAt: NOW - 20 * 3600_000,
    });
    const today = await resolveDayGate("pf", "paper", "90", "0.03", NOW);
    expect(today.latched).toBe(false);
    expect(today.row.baselineEquity).toBe("90");
    const rows = (await testSql()`SELECT count(*)::int AS c FROM daily_equity`) as { c: number }[];
    expect(rows[0].c).toBe(2);
  });

  it("nem mérhető equity mellett nincs napi hozam és tiltott az új vétel", async () => {
    const r = await resolveDayGate("pf", "paper", null, "0.03", NOW);
    expect(r.dayPnlPct).toBeNull();
    expect(r.blockNewBuys).toBe(true);
  });
});

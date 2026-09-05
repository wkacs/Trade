import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { resetSchema, truncateAll, testSql } from "./db-helpers";
import {
  readLegacyState,
  planLegacyImport,
  applyLegacyImport,
  readCurrentLedgerSnapshot,
  buildDiff,
} from "@/lib/portfolio/legacy-import";
import { loadLedgerState } from "@/lib/execution/order-store";

/**
 * T11 — a régi adat megőrzése és a mérési átállás valódi PostgreSQL ellen.
 *
 * Amit bizonyít:
 *  - a kétszeri import UGYANAZT adja (idempotens);
 *  - a v1 sorok érintetlenek maradnak;
 *  - a nyitóállapot az ellenőrzött v1 állapotból jön, nem a trade-ek újrajátszásából;
 *  - a történeti sorok legacy-unverified provenance-t kapnak és nem mozgatnak egyenleget;
 *  - a koncentrált pozíciót a migráció NEM adja el.
 */
describe("legacy import — valódi PostgreSQL", () => {
  const EPOCH = "v2-test-epoch";

  beforeAll(async () => {
    await resetSchema();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    const sql = testSql();
    await sql`INSERT INTO portfolios (initial_capital_usd, cash_usd, mode) VALUES (100, 0.09354296, 'paper')`;
    const [{ id: pid }] = (await sql`SELECT id FROM portfolios LIMIT 1`) as { id: string }[];
    await sql`INSERT INTO positions (symbol, qty, entry_price, stop_price) VALUES ('BTC', 0.001688317, 59000, 56050)`;
    const [{ id: posId }] = (await sql`SELECT id FROM positions LIMIT 1`) as { id: string }[];
    await sql`INSERT INTO trades (position_id, symbol, side, amount_usd, price, qty, fee_usd, mode, origin)
              VALUES (${posId}, 'BTC', 'BUY', 2, 59000, 0.0000338, 0.002, 'paper', 'ai')`;
    await sql`INSERT INTO trades (position_id, symbol, side, amount_usd, price, qty, fee_usd, mode, origin)
              VALUES (${posId}, 'BTC', 'BUY', 3, 60000, 0.00005, 0.003, 'paper', NULL)`;
    void pid;
  });

  it("a dry-run terv nem ír semmit", async () => {
    const legacy = (await readLegacyState())!;
    const plan = planLegacyImport(legacy, { epochVersion: EPOCH });
    const before = await readCurrentLedgerSnapshot(plan.portfolioId, plan.mode);
    expect(before.cash).toBe("0");
    const rows = (await testSql()`SELECT count(*)::int AS c FROM execution_fills`) as { c: number }[];
    expect(rows[0].c).toBe(0);
    expect(plan.legacyFills).toHaveLength(2);
  });

  it("az import felveszi az epochot, a nyitóállapotot és a történeti sorokat", async () => {
    const legacy = (await readLegacyState())!;
    const plan = planLegacyImport(legacy, { epochVersion: EPOCH });
    const result = await applyLegacyImport(plan, Date.UTC(2026, 8, 5));

    expect(result.epochCreated).toBe(true);
    expect(result.openingSeeded).toBe(true);
    expect(result.legacyFillsInserted).toBe(2);

    const ledger = await loadLedgerState({ portfolioId: plan.portfolioId, mode: "paper" });
    expect(ledger.cash.USDT).toBe("0.09354296");
    expect(ledger.positions.BTC.qty).toBe("0.001688317");

    const provenance = (await testSql()`SELECT DISTINCT provenance FROM execution_fills`) as {
      provenance: string;
    }[];
    expect(provenance).toEqual([{ provenance: "legacy-unverified" }]);
  });

  it("kétszeri import ugyanazt adja (idempotens), nem duplikál", async () => {
    const legacy = (await readLegacyState())!;
    const plan = planLegacyImport(legacy, { epochVersion: EPOCH });
    await applyLegacyImport(plan, Date.UTC(2026, 8, 5));
    const second = await applyLegacyImport(plan, Date.UTC(2026, 8, 5));

    expect(second.epochCreated).toBe(false);
    expect(second.openingSeeded).toBe(false);
    expect(second.legacyFillsInserted).toBe(0);
    expect(second.legacyFillsSkipped).toBe(2);

    const fills = (await testSql()`SELECT count(*)::int AS c FROM execution_fills`) as { c: number }[];
    const epochs = (await testSql()`SELECT count(*)::int AS c FROM ledger_epochs`) as { c: number }[];
    expect(fills[0].c).toBe(2);
    expect(epochs[0].c).toBe(1);
  });

  it("a v1 sorok érintetlenek maradnak", async () => {
    const legacy = (await readLegacyState())!;
    await applyLegacyImport(planLegacyImport(legacy, { epochVersion: EPOCH }), Date.now());
    const sql = testSql();
    const portfolios = (await sql`SELECT cash_usd FROM portfolios`) as { cash_usd: number }[];
    const positions = (await sql`SELECT count(*)::int AS c FROM positions`) as { c: number }[];
    const trades = (await sql`SELECT count(*)::int AS c FROM trades`) as { c: number }[];
    expect(Number(portfolios[0].cash_usd)).toBeCloseTo(0.09354296, 8);
    expect(positions[0].c).toBe(1);
    expect(trades[0].c).toBe(2);
  });

  it("a történeti sorok NEM mozgatnak egyenleget", async () => {
    const legacy = (await readLegacyState())!;
    const plan = planLegacyImport(legacy, { epochVersion: EPOCH });
    await applyLegacyImport(plan, Date.now());
    const ledger = await loadLedgerState({ portfolioId: plan.portfolioId, mode: "paper" });
    // A nyitó készpénz PONTOSAN a v1 érték — a két legacy BUY nem vonódott le újra.
    expect(ledger.cash.USDT).toBe("0.09354296");
  });

  it("az eltérésjelentés előtte/utána értéket ad", async () => {
    const legacy = (await readLegacyState())!;
    const plan = planLegacyImport(legacy, { epochVersion: EPOCH });
    const before = await readCurrentLedgerSnapshot(plan.portfolioId, plan.mode);
    await applyLegacyImport(plan, Date.now());
    const after = await readCurrentLedgerSnapshot(plan.portfolioId, plan.mode);

    const diff = buildDiff(before, plan);
    expect(diff.find((r) => r.key === "cash:USDT")!.after).toBe(after.cash);
    expect(after.positions.BTC).toBe("0.001688317");
  });

  it("a koncentrált BTC-pozíciót a migráció NEM adja el", async () => {
    const legacy = (await readLegacyState())!;
    const plan = planLegacyImport(legacy, { epochVersion: EPOCH });
    await applyLegacyImport(plan, Date.now());
    const ledger = await loadLedgerState({ portfolioId: plan.portfolioId, mode: "paper" });
    expect(Number(ledger.positions.BTC.qty)).toBeGreaterThan(0);
    // Nincs SELL fill az importból.
    const sells = (await testSql()`SELECT count(*)::int AS c FROM execution_fills WHERE side = 'SELL'`) as {
      c: number;
    }[];
    expect(sells[0].c).toBe(0);
  });
});

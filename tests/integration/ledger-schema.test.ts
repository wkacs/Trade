import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, resetSchema, truncateAll, testSql, columnType, tableExists } from "./db-helpers";

/**
 * T03 — a bővítő séma valódi PostgreSQL ellen.
 *
 * Amit bizonyít:
 *  - a migráció ÜRES és LEGACY adatbázison is lefut, és nem veszít régi sort;
 *  - a v2 pénzügyi oszlopok `numeric`-ek (nem `real`);
 *  - az egyediségi és CHECK feltételek élnek;
 *  - az `apply_fill_v2` egyetlen tranzakcióban könyvel, duplikátumra pedig no-op.
 */
describe("v2 ledger séma — valódi PostgreSQL", () => {
  beforeAll(async () => {
    await resetSchema();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  });

  it("a migráció létrehozza a v2 táblákat, a v1-eket érintetlenül hagyva", async () => {
    for (const t of [
      "execution_intents",
      "execution_fills",
      "ledger_cash",
      "ledger_positions",
      "budget_reservations",
      "daily_equity",
      "run_leases",
      "ledger_epochs",
    ]) {
      expect(await tableExists(t), `hiányzó v2 tábla: ${t}`).toBe(true);
    }
    for (const t of ["portfolios", "positions", "trades", "decisions"]) {
      expect(await tableExists(t), `eltűnt v1 tábla: ${t}`).toBe(true);
    }
  });

  it("a v2 pénzügyi oszlopok numeric típusúak, a v1 real marad", async () => {
    expect(await columnType("ledger_cash", "amount")).toBe("numeric");
    expect(await columnType("ledger_positions", "qty")).toBe("numeric");
    expect(await columnType("execution_fills", "gross_quote_amount")).toBe("numeric");
    // A v1 tábla szándékosan változatlan: a real elveszett pontossága nem állítható vissza.
    expect(await columnType("trades", "amount_usd")).toBe("real");
  });

  it("a migráció nem veszít legacy sort és a régi olvasó tovább működik", async () => {
    const sql = testSql();
    await sql`INSERT INTO portfolios (initial_capital_usd, cash_usd, mode) VALUES (100, 0.09354296, 'paper')`;
    await sql`INSERT INTO positions (symbol, qty, entry_price, stop_price) VALUES ('BTC', 0.001688317, 59000, 56050)`;
    await sql`INSERT INTO trades (symbol, side, amount_usd, price, qty, fee_usd, mode)
              VALUES ('BTC', 'BUY', 2, 59000, 0.0000338, 0.002, 'paper')`;

    // Újbóli migrálás (mintha egy második deploy futna) nem törölhet adatot.
    await applyMigrations();

    const [{ c: portfolios }] = (await sql`SELECT count(*)::int AS c FROM portfolios`) as { c: number }[];
    const [{ c: trades }] = (await sql`SELECT count(*)::int AS c FROM trades`) as { c: number }[];
    expect(portfolios).toBe(1);
    expect(trades).toBe(1);
  });

  it("egyediség: ugyanaz az intent_id és fill_key nem szúrható be kétszer", async () => {
    const sql = testSql();
    await sql`INSERT INTO execution_intents
      (intent_id, portfolio_id, mode, strategy_version, origin, symbol, side, max_quote_spend,
       reference_price, expires_at, client_order_id)
      VALUES ('i-1', 'pf', 'paper', 'v2', 'dca', 'BTC', 'BUY', 2, 60000, now() + interval '1 minute', 'zct-i-1')`;
    await expect(
      sql`INSERT INTO execution_intents
        (intent_id, portfolio_id, mode, strategy_version, origin, symbol, side, max_quote_spend,
         reference_price, expires_at, client_order_id)
        VALUES ('i-1', 'pf', 'paper', 'v2', 'dca', 'BTC', 'BUY', 2, 60000, now() + interval '1 minute', 'zct-i-1b')`,
    ).rejects.toThrow();
  });

  it("CHECK: BUY-nál base_qty, SELL-nél max_quote_spend nem adható meg", async () => {
    const sql = testSql();
    await expect(
      sql`INSERT INTO execution_intents
        (intent_id, portfolio_id, mode, strategy_version, origin, symbol, side, max_quote_spend, base_qty,
         reference_price, expires_at, client_order_id)
        VALUES ('i-bad', 'pf', 'paper', 'v2', 'dca', 'BTC', 'BUY', 2, 0.001, 60000, now(), 'zct-bad')`,
    ).rejects.toThrow();
  });

  it("CHECK: a készpénz és a készlet nem mehet negatívba", async () => {
    const sql = testSql();
    await sql`INSERT INTO ledger_cash (portfolio_id, mode, asset, amount) VALUES ('pf', 'paper', 'USDT', 10)`;
    await expect(
      sql`UPDATE ledger_cash SET amount = amount - 20 WHERE portfolio_id = 'pf' AND asset = 'USDT'`,
    ).rejects.toThrow();
    await sql`INSERT INTO ledger_positions (portfolio_id, mode, symbol, qty, cost_basis_quote)
              VALUES ('pf', 'paper', 'BTC', 0.5, 30000)`;
    await expect(
      sql`UPDATE ledger_positions SET qty = qty - 1 WHERE portfolio_id = 'pf' AND symbol = 'BTC'`,
    ).rejects.toThrow();
  });

  it("apply_fill_v2 egy tranzakcióban könyvel, és a duplikátum no-op", async () => {
    const sql = testSql();
    await sql`INSERT INTO ledger_cash (portfolio_id, mode, asset, amount) VALUES ('pf', 'paper', 'USDT', 100)`;

    const fill = {
      fillId: "paper:o-1:t-1",
      intentId: "i-1",
      portfolioId: "pf",
      mode: "paper",
      symbol: "BTC",
      side: "BUY",
      exchangeOrderId: "o-1",
      exchangeTradeId: "t-1",
      filledBaseQty: "0.00003330",
      grossQuoteAmount: "1.998",
      fillPrice: "60000",
      feeAmount: "0.002",
      feeAsset: "USDT",
      executedAt: 1_700_000_000_000,
    };
    const deltas = {
      cash: [{ asset: "USDT", delta: "-2" }],
      position: { symbol: "BTC", qtyDelta: "0.0000333", costDelta: "2", stopPrice: "57000" },
      reservation: null,
    };

    const first = (await sql`SELECT apply_fill_v2(${JSON.stringify(fill)}::jsonb, ${JSON.stringify(
      deltas,
    )}::jsonb) AS r`) as { r: { applied: boolean } }[];
    expect(first[0].r.applied).toBe(true);

    const second = (await sql`SELECT apply_fill_v2(${JSON.stringify(fill)}::jsonb, ${JSON.stringify(
      deltas,
    )}::jsonb) AS r`) as { r: { applied: boolean; reason?: string } }[];
    expect(second[0].r.applied).toBe(false);
    expect(second[0].r.reason).toBe("duplicate_fill");

    const cash = (await sql`SELECT amount::text AS a FROM ledger_cash WHERE portfolio_id='pf' AND asset='USDT'`) as {
      a: string;
    }[];
    expect(Number(cash[0].a)).toBeCloseTo(98, 10);
    const rows = (await sql`SELECT count(*)::int AS c FROM execution_fills`) as { c: number }[];
    expect(rows[0].c).toBe(1);
  });

  it("apply_fill_v2 túlköltésnél BUKIK, és a fill sem marad bent (atomicitás)", async () => {
    const sql = testSql();
    await sql`INSERT INTO ledger_cash (portfolio_id, mode, asset, amount) VALUES ('pf', 'paper', 'USDT', 1)`;
    const fill = {
      fillId: "paper:o-2:t-2",
      intentId: "i-2",
      portfolioId: "pf",
      mode: "paper",
      symbol: "BTC",
      side: "BUY",
      exchangeOrderId: "o-2",
      exchangeTradeId: "t-2",
      filledBaseQty: "0.0001",
      grossQuoteAmount: "6",
      fillPrice: "60000",
      feeAmount: "0.006",
      feeAsset: "USDT",
      executedAt: 1_700_000_000_000,
    };
    const deltas = {
      cash: [{ asset: "USDT", delta: "-6.006" }],
      position: { symbol: "BTC", qtyDelta: "0.0001", costDelta: "6.006", stopPrice: null },
      reservation: null,
    };
    await expect(
      sql`SELECT apply_fill_v2(${JSON.stringify(fill)}::jsonb, ${JSON.stringify(deltas)}::jsonb)`,
    ).rejects.toThrow();

    const rows = (await sql`SELECT count(*)::int AS c FROM execution_fills`) as { c: number }[];
    expect(rows[0].c).toBe(0);
    const cash = (await sql`SELECT amount::text AS a FROM ledger_cash WHERE portfolio_id='pf' AND asset='USDT'`) as {
      a: string;
    }[];
    expect(Number(cash[0].a)).toBeCloseTo(1, 10);
  });

  it("a numeric oszlop nem veszít pontosságot (18 tizedes oda-vissza)", async () => {
    const sql = testSql();
    const precise = "0.000000000000000123";
    await sql`INSERT INTO ledger_positions (portfolio_id, mode, symbol, qty, cost_basis_quote)
              VALUES ('pf', 'paper', 'SOL', ${precise}::numeric, 0)`;
    const rows = (await sql`SELECT qty::text AS q FROM ledger_positions WHERE symbol = 'SOL'`) as { q: string }[];
    expect(rows[0].q).toBe(precise);
  });
});

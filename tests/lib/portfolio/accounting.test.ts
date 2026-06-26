import { describe, it, expect } from "vitest";
import { applyTrade } from "@/lib/portfolio/accounting";
import type { Trade } from "@/lib/types";
import type { Db } from "@/db/client";

/**
 * Olyan mock DB, ami számontartja a Drizzle-műveleteket táblánként.
 * A query-builder láncolást (select/from/where/limit, insert/values/returning,
 * update/set/where) szimulálja, és előre beállított pozíciókat ad vissza a select-re.
 *
 * Cél: tiszta, DB nélküli egységtesztek, ahol a kijelentések a MŰVELETEKRE szólnak
 * (melyik táblán INSERT/UPDATE történt, milyen értékekkel), nem csak a visszatérésre.
 */
function makeMockDb(openPositions: any[]) {
  const ops: {
    kind: "select" | "insert" | "update";
    table: string;
    values?: any; // insert/update értékek
    where?: any;
  }[] = [];

  // Drizzle thenable: a lánc vége egy Promise-ként viselkedik.
  // A 'resolve'-t aszerint adjuk meg, milyen művelet készült.
  const chain = (record: { kind: any; table: any; values?: any; where?: any }) => {
    const self: any = {
      from() {
        return self;
      },
      where(cond: any) {
        record.where = cond;
        return self;
      },
      limit() {
        return self;
      },
      orderBy() {
        return self;
      },
      set(values: any) {
        record.values = values;
        return self;
      },
      values(values: any) {
        record.values = values;
        // insert().values().returning() → visszaadjuk az új sort
        return self;
      },
      // returning() után (vagy a lánc végén) Promise-ként viselkedik:
      async returning() {
        if (record.kind === "insert") {
          return [{ id: "inserted-id" }];
        }
        return [{ id: "updated-id" }];
      },
    };
    // Ha nincs .returning() (pl. update csak .set().where()), akkor a thenable:
    self.then = (resolve: any, reject: any) => {
      try {
        if (record.kind === "select") {
          resolve(openPositions);
        } else if (record.kind === "insert") {
          resolve([{ id: "inserted-id" }]);
        } else if (record.kind === "update") {
          resolve([{ id: "updated-id" }]);
        } else {
          resolve([]);
        }
      } catch (e) {
        reject(e);
      }
    };
    ops.push(record as any);
    return self;
  };

  const db: any = {
    select() {
      return chain({ kind: "select", table: "positions" });
    },
    insert(table: any) {
      const t = table?.symbol !== undefined ? "positions" : "unknown";
      return chain({ kind: "insert", table: "positions-or-trades" });
    },
    update(table: any) {
      return chain({ kind: "update", table: "portfolios-or-positions" });
    },
  };

  return { db, ops };
}

const trade = (over: Partial<Trade>): Trade => ({
  id: "trade-1",
  orderId: "order-1",
  symbol: "BTC",
  side: "BUY",
  amountUsd: 2000,
  price: 60000,
  qty: 2000 / 60000,
  feeUsd: 2,
  executedAt: Date.now(),
  mode: "paper",
  ...over,
});

describe("applyTrade", () => {
  it("nincs DB esetén null-t ad vissza", async () => {
    const result = await applyTrade(trade({}), 57000, null as any);
    expect(result).toBeNull();
  });

  it("BUY új pozíciót nyit: positions INSERT + trades INSERT + cash csökkent (portfolios UPDATE)", async () => {
    const { db, ops } = makeMockDb([]); // nincs nyitott BTC pozíció
    const result = await applyTrade(
      trade({ side: "BUY", symbol: "BTC", amountUsd: 2000, price: 60000, qty: 0.0333 }),
      57000,
      db as unknown as Db,
    );

    expect(result).toEqual({ positionId: "inserted-id" });
    // volt egy select (nyitott pozíció keresése)
    expect(ops.some((o) => o.kind === "select")).toBe(true);
    // volt INSERT (új pozíció + trade = legalább 2 insert)
    const inserts = ops.filter((o) => o.kind === "insert");
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    // volt UPDATE a portfolios cash-en
    const updates = ops.filter((o) => o.kind === "update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it("BUY meglévő pozíciót növel: positions UPDATE (ár-átlagolás), NEM új INSERT pozícióra", async () => {
    const { db, ops } = makeMockDb([
      { id: "pos-1", symbol: "BTC", qty: 0.02, entryPrice: 50000, stopPrice: 47500 },
    ]);
    const result = await applyTrade(
      trade({ side: "BUY", symbol: "BTC", amountUsd: 2000, price: 60000, qty: 0.0333 }),
      57000,
      db as unknown as Db,
    );

    // meglévő pozíció id-ját használja
    expect(result).toEqual({ positionId: "pos-1" });
    // a pozíción UPDATE történt (ár-átlagolással)
    const updates = ops.filter((o) => o.kind === "update" && o.values && "qty" in o.values);
    expect(updates.length).toBe(1);
    // ár-átlagolás: ((0.02*50000)+(0.0333*60000))/(0.02+0.0333) ≈ 56247
    expect(updates[0].values.entryPrice).toBeGreaterThan(50000);
    expect(updates[0].values.entryPrice).toBeLessThan(60000);
  });

  it("SELL részleges: pozíció qty csökken, cash nő", async () => {
    const { db, ops } = makeMockDb([
      { id: "pos-1", symbol: "BTC", qty: 0.05, entryPrice: 60000, stopPrice: 57000 },
    ]);
    const result = await applyTrade(
      trade({ side: "SELL", symbol: "BTC", amountUsd: 1500, price: 60000, qty: 0.025 }),
      57000,
      db as unknown as Db,
    );

    expect(result).toEqual({ positionId: "pos-1" });
    const updates = ops.filter((o) => o.kind === "update" && o.values && "qty" in o.values);
    expect(updates.length).toBe(1);
    // 0.05 - 0.025 = 0.025
    expect(updates[0].values.qty).toBeCloseTo(0.025, 6);
    // nem zártuk le (nincs closedAt)
    expect(updates[0].values.closedAt).toBeUndefined();
  });

  it("SELL ami lezárja: qty ≈ 0 → closedAt beállít", async () => {
    const { db, ops } = makeMockDb([
      { id: "pos-1", symbol: "BTC", qty: 0.0333, entryPrice: 60000, stopPrice: 57000 },
    ]);
    const result = await applyTrade(
      trade({ side: "SELL", symbol: "BTC", amountUsd: 2000, price: 60000, qty: 0.0333 }),
      57000,
      db as unknown as Db,
    );

    expect(result).toEqual({ positionId: "pos-1" });
    const updates = ops.filter((o) => o.kind === "update" && o.values && "qty" in o.values);
    expect(updates.length).toBe(1);
    // lezárva: closedAt be van állítva, qty 0
    expect(updates[0].values.closedAt).toBeInstanceOf(Date);
    expect(updates[0].values.qty).toBe(0);
  });
});

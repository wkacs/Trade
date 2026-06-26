import { describe, it, expect } from "vitest";
import { spentThisWeekUsd, remainingWeeklyBudget } from "@/lib/strategy/weekly-budget";
import type { Db } from "@/db/client";

/**
 * Mock DB: a select().from().where() láncot egy preset összeg-sorra oldja fel
 * ([{ total }]). Az `errorMode` szimulálja a lekérdezés hibáját (konzervatív ág).
 */
function makeMockDb(total: number, errorMode = false): Db {
  const chain: any = {
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    then(resolve: any, reject: any) {
      if (errorMode) reject(new Error("db down"));
      else resolve([{ total }]);
    },
  };
  return { select: () => chain } as unknown as Db;
}

describe("weekly-budget — görgő 7 napos DCA-keret", () => {
  it("nincs DB → spentThisWeekUsd 0", async () => {
    expect(await spentThisWeekUsd(null)).toBe(0);
  });

  it("nincs DB → a teljes keret elérhető (equity * 5%)", async () => {
    expect(await remainingWeeklyBudget(1000, null)).toBeCloseTo(50, 6);
  });

  it("a trades táblából összegzett BUY/paper összeget adja vissza", async () => {
    expect(await spentThisWeekUsd(makeMockDb(30))).toBe(30);
  });

  it("remaining = equity*5% − elköltött", async () => {
    expect(await remainingWeeklyBudget(1000, makeMockDb(30))).toBeCloseTo(20, 6);
  });

  it("túlköltés esetén nem megy negatívba (0)", async () => {
    expect(await remainingWeeklyBudget(1000, makeMockDb(80))).toBe(0);
  });

  it("lekérdezési hiba → konzervatívan 0 keret (mintha elfogyott volna)", async () => {
    expect(await remainingWeeklyBudget(1000, makeMockDb(0, true))).toBe(0);
  });
});

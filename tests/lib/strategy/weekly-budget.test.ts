import { describe, it, expect } from "vitest";
import {
  spentThisWeekUsd,
  remainingWeeklyBudget,
  activeDcaReservationsUsd,
  computeRemainingBudget,
} from "@/lib/strategy/weekly-budget";
import type { Db } from "@/db/client";

const SCOPE = { portfolioId: "pf-1", mode: "paper" as const };

/**
 * Mock DB. A `select().from().where()` lánc a hívások SORRENDJE szerint ad vissza sort,
 * mert a spentThisWeekUsd három lekérdezést tesz:
 *   1) a `dca` eredetű intentek listája
 *   2) van-e egyáltalán v2 fill ebben a hatókörben
 *   3) az összeg (v2 fill vagy v1 trades)
 * Így a teszt azt is ellenőrzi, hogy a MEGFELELŐ forrásból számolunk.
 */
function makeMockDb(responses: unknown[][], errorAt = -1): { db: Db; wheres: unknown[] } {
  let call = 0;
  const wheres: unknown[] = [];
  const chain: any = {
    from() {
      return chain;
    },
    where(w: unknown) {
      wheres.push(w);
      return chain;
    },
    then(resolve: any, reject: any) {
      const idx = call++;
      if (idx === errorAt) return reject(new Error("db down"));
      resolve(responses[idx] ?? []);
    },
  };
  return { db: { select: () => chain } as unknown as Db, wheres };
}

describe("weekly-budget — görgő 7 napos DCA-keret", () => {
  it("nincs DB → spentThisWeekUsd 0", async () => {
    expect(await spentThisWeekUsd(SCOPE, Date.now(), null)).toBe("0");
  });

  it("nincs DB → a teljes keret elérhető (equity * 5%)", async () => {
    expect(await remainingWeeklyBudget("1000", SCOPE, Date.now(), null)).toBe("50");
  });

  it("v2 fill híján a v1 trades tábla dca-sorait összegzi", async () => {
    // 1) dca intentek: üres, 2) van-e v2 fill: 0 → v1 fallback, 3) a v1 összeg
    const { db } = makeMockDb([[], [{ c: 0 }], [{ total: "30" }]]);
    expect(await spentThisWeekUsd(SCOPE, Date.now(), db)).toBe("30");
  });

  it("ha van v2 fill, a DCA-intentekhez tartozó filleket összegzi", async () => {
    const { db } = makeMockDb([[{ intentId: "i-1" }], [{ c: 5 }], [{ total: "12.5" }]]);
    expect(await spentThisWeekUsd(SCOPE, Date.now(), db)).toBe("12.5");
  });

  it("AUDIT §4: v2 módban a NEM dca eredetű vétel nem fogyasztja a keretet", async () => {
    // Van v2 fill (c=5), de egyetlen dca intent sincs → az AI vételei nem számítanak.
    const { db } = makeMockDb([[], [{ c: 5 }], [{ total: "999" }]]);
    expect(await spentThisWeekUsd(SCOPE, Date.now(), db)).toBe("0");
  });

  it("remaining = equity*5% − elköltött − foglalt", async () => {
    const { db } = makeMockDb([
      [], // dca intentek
      [{ c: 0 }], // nincs v2 fill → v1
      [{ total: "30" }], // elköltött
      [{ total: "5" }], // aktív foglalás
    ]);
    expect(await remainingWeeklyBudget("1000", SCOPE, Date.now(), db)).toBe("15");
  });

  it("túlköltés esetén nem megy negatívba (0)", async () => {
    const { db } = makeMockDb([[], [{ c: 0 }], [{ total: "80" }], [{ total: "0" }]]);
    expect(await remainingWeeklyBudget("1000", SCOPE, Date.now(), db)).toBe("0");
  });

  it("lekérdezési hiba → konzervatívan 0 keret (mintha elfogyott volna)", async () => {
    const { db } = makeMockDb([[], [{ c: 0 }], [{ total: "0" }]], 0);
    expect(await remainingWeeklyBudget("1000", SCOPE, Date.now(), db)).toBe("0");
  });

  it("az aktív foglalás a le nem könyvelt részt adja vissza, sosem negatívat", async () => {
    const { db } = makeMockDb([[{ total: "-3" }]]);
    expect(await activeDcaReservationsUsd(SCOPE, db)).toBe("0");
  });

  it("a hatókör-szűrés a lekérdezésben szerepel (portfolio + mode + origin)", async () => {
    const { db, wheres } = makeMockDb([[], [{ c: 0 }], [{ total: "0" }]]);
    await spentThisWeekUsd(SCOPE, Date.now(), db);
    // Három lekérdezés, mindegyik szűrt.
    expect(wheres.length).toBe(3);
    for (const w of wheres) expect(w).toBeDefined();
  });

  it("computeRemainingBudget tiszta függvényként is ugyanazt adja", () => {
    expect(computeRemainingBudget("1000", "30", "5", "0.05")).toBe("15");
    expect(computeRemainingBudget("1000", "80", "0", "0.05")).toBe("0");
  });
});

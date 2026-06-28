# Folyamat-átláthatóság (teljes tick-napló) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dashboard tegye átláthatóvá a bot teljes folyamatát — minden trade hajtóereje (origin), a tickenkénti teljes döntési lánc (tick_runs napló + TickInspector), a tényleges bemenetek, és a hangolt stratégia szabályai.

**Architecture:** Egy additív DB-réteg (`tick_runs` tábla + `trades.origin` oszlop) rögzíti tickenként a teljes folyamatot; a `runTick` egy tiszta `buildTickProcess`-szel állítja össze a `TickProcess`-t és a `TickResult.process`-ben adja vissza, az `executeScheduledTick` best-effort beszúrja. A megjelenítés négy felületen olvassa: trade-eredet badge, `TickInspector` lánc-nézet, gazdagabb `DecisionDetail`, statikus `StrategyPanel`.

**Tech Stack:** Next.js 14 (App Router) + Drizzle ORM + Neon Postgres + Vitest (TDD) + Tailwind (meglévő „trading terminál" tokenek).

## Global Constraints

- **Best-effort perzisztencia:** a napló / origin hibája SOHA ne buktassa a ticket (`try/catch`, mint a meglévő hookok).
- **Additív, visszafelé kompatibilis séma:** új tábla + **nullable** oszlop; a régi kód a régi adattal is fut.
- **Egy Neon DB** (`.env.local` == prod, `ep-super-meadow`) — a migráció élő adatot érint, de additív → biztonságos.
- **Magyar kommentek, `@/`-alias importok, a meglévő teszt-minta** (`tests/lib/...` tükrözi `src/lib/...`).
- **A tiszta logika nem hív** `Date.now`/`Math.random`/IO-t (determinizmus, unit-tesztelhetőség).
- **UI vizuálisan verifikálva** (`pnpm dev` / prod), a tesztek lib-szintűek.
- **Teljes kapu minden érdemi task után:** `pnpm vitest run` zöld, `pnpm exec tsc --noEmit` 0, `pnpm build` zöld.

---

## Task 1: Séma — `tick_runs` tábla + `trades.origin` oszlop + migráció

**Files:**
- Modify: `src/db/schema.ts` (a `trades` tábla + új `tickRuns` tábla)
- Test: `tests/lib/db/schema.test.ts` (új)

**Interfaces:**
- Produces: `schema.tickRuns` (drizzle tábla), `schema.trades.origin` (oszlop). Olvassa: Task 3 (`insertTickRun`, `applyTrade`), Task 4 (`/api/ticks`).

- [ ] **Step 1: Írd meg a bukó tesztet**

`tests/lib/db/schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { schema } from "@/db/client";

describe("schema — folyamat-napló", () => {
  it("van tickRuns tábla", () => {
    expect(schema.tickRuns).toBeDefined();
  });
  it("a trades táblának van origin oszlopa", () => {
    expect(schema.trades.origin).toBeDefined();
  });
});
```

- [ ] **Step 2: Futtasd, ellenőrizd hogy BUKIK**

Run: `pnpm vitest run tests/lib/db/schema.test.ts`
Expected: FAIL — `schema.tickRuns` és `schema.trades.origin` még nincs.

- [ ] **Step 3: Add hozzá az oszlopot + táblát**

`src/db/schema.ts` — a `trades` tábla `executedAt` sora UTÁN (a `}` előtt) szúrd be:
```ts
  origin: varchar("origin", { length: 12 }), // dca|stop-loss|take-profit|ai|manual (nullable: régi sorok)
```

`src/db/schema.ts` — a `trades` tábla blokk UTÁN add hozzá:
```ts
/** Tickenkénti teljes folyamat-napló (átláthatóság): inputok + lánc + akciók. */
export const tickRuns = pgTable("tick_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  tickId: varchar("tick_id", { length: 16 }).notNull(), // YYYY-MM-DD-HH
  process: jsonb("process").notNull(), // TickProcess (lásd src/lib/engine/tick-process.ts)
});
```
(A `varchar`, `jsonb`, `uuid`, `timestamp` már importálva a fájl tetején.)

Ellenőrizd, hogy a `db/client.ts` a teljes `schema`-t exportálja (a `schema.tickRuns` elérhető legyen). Ha a `schema` objektum egyenként sorolja a táblákat, add hozzá a `tickRuns`-t.

- [ ] **Step 4: Futtasd, ellenőrizd hogy ÁTMEGY**

Run: `pnpm vitest run tests/lib/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Generáld + futtasd a migrációt**

Run: `pnpm db:generate`
Expected: új SQL fájl a `src/db/migrations/`-ben (`ALTER TABLE "trades" ADD COLUMN "origin" ...` + `CREATE TABLE "tick_runs" ...`).

Run: `pnpm db:migrate`
Expected: a migráció lefut a DB-re (egy Neon `ep-super-meadow`); additív, nem-destruktív. Ha `db:migrate` interaktív/környezetfüggő, használd a projekt bevett migrációs parancsát (`node --env-file=.env.local` a drizzle-migrate scripttel).

- [ ] **Step 6: tsc + commit**

Run: `pnpm exec tsc --noEmit` → 0 hiba.
```bash
git add src/db/schema.ts src/db/migrations tests/lib/db/schema.test.ts
git commit -m "feat(db): tick_runs napló-tábla + trades.origin oszlop (additív migráció)"
```

---

## Task 2: `TickProcess` típus + `buildTickProcess` (tiszta, TDD)

**Files:**
- Create: `src/lib/engine/tick-process.ts`
- Test: `tests/lib/engine/tick-process.test.ts`

**Interfaces:**
- Consumes: `CycleAction` (`@/lib/engine/tick`).
- Produces: `TradeOrigin` (típus), `TickProcess` (típus), `TickProcessInput` (típus), `buildTickProcess(input: TickProcessInput): TickProcess`.

- [ ] **Step 1: Írd meg a bukó tesztet**

`tests/lib/engine/tick-process.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildTickProcess, type TickProcessInput } from "@/lib/engine/tick-process";

const base: TickProcessInput = {
  tickId: "2026-06-28-11",
  prices: { BTC: 60000, SOL: 150 },
  fearGreed: { value: 15, classification: "Extreme Fear" },
  mlSignals: [{ symbol: "BTC", direction1h: "up", confidence: 0.55 }],
  cycleActions: [{ kind: "dca", side: "BUY", symbol: "SOL", amountUsd: 20, qty: 0.13 }],
  phase1: { shouldDecide: false, summary: "csendes piac" },
  phase2: null,
  decision: { action: "HOLD", symbol: null, overridden: false, overrideReason: null },
  aiTrade: null,
};

describe("buildTickProcess", () => {
  it("a cycleActions-ből trade-et készít az eredettel (kind = origin)", () => {
    const p = buildTickProcess(base);
    expect(p.trades).toEqual([{ symbol: "SOL", side: "BUY", origin: "dca", amountUsd: 20 }]);
    expect(p.inputs.fearGreed?.value).toBe(15);
    expect(p.phase2).toBeNull();
  });

  it("az AI-trade-et 'ai' eredettel hozzáfűzi a cycle-trade-ek után", () => {
    const p = buildTickProcess({
      ...base,
      cycleActions: [],
      phase1: { shouldDecide: true, summary: "ETF hír" },
      phase2: { action: "BUY", symbol: "BTC", amountPct: 0.1, confidence: 0.7, reasoning: "bullish" },
      decision: { action: "BUY", symbol: "BTC", overridden: false, overrideReason: null },
      aiTrade: { symbol: "BTC", side: "BUY", amountUsd: 100 },
    });
    expect(p.trades).toEqual([{ symbol: "BTC", side: "BUY", origin: "ai", amountUsd: 100 }]);
    expect(p.phase2?.action).toBe("BUY");
  });
});
```

- [ ] **Step 2: Futtasd, ellenőrizd hogy BUKIK**

Run: `pnpm vitest run tests/lib/engine/tick-process.test.ts`
Expected: FAIL — a modul még nem létezik.

- [ ] **Step 3: Implementáld**

`src/lib/engine/tick-process.ts`:
```ts
import type { CycleAction } from "@/lib/engine/tick";

/** Egy trade hajtóereje. */
export type TradeOrigin = "dca" | "stop-loss" | "take-profit" | "ai" | "manual";

/** A tickenkénti teljes folyamat pillanatképe (a tick_runs.process JSON alakja). */
export interface TickProcess {
  tickId: string;
  inputs: {
    prices: Record<string, number>;
    fearGreed: { value: number; classification: string } | null;
    mlSignals: { symbol: string; direction1h: string; confidence: number }[];
  };
  cycleActions: { kind: "stop-loss" | "take-profit" | "dca"; side: "BUY" | "SELL"; symbol: string; qty?: number; amountUsd?: number }[];
  phase1: { shouldDecide: boolean; summary: string };
  phase2: { action: "BUY" | "SELL" | "HOLD"; symbol: string | null; amountPct: number; confidence: number; reasoning: string } | null;
  decision: { action: "BUY" | "SELL" | "HOLD"; symbol: string | null; overridden: boolean; overrideReason: string | null };
  trades: { symbol: string; side: "BUY" | "SELL"; origin: TradeOrigin; amountUsd: number }[];
}

export interface TickProcessInput {
  tickId: string;
  prices: Record<string, number>;
  fearGreed: { value: number; classification: string } | null;
  mlSignals: { symbol: string; direction1h: string; confidence: number }[];
  cycleActions: CycleAction[];
  phase1: { shouldDecide: boolean; summary: string };
  phase2: TickProcess["phase2"];
  decision: TickProcess["decision"];
  aiTrade: { symbol: string; side: "BUY" | "SELL"; amountUsd: number } | null;
}

/**
 * Tiszta összeállító: a runTick belsőkből egységes TickProcess-t épít. A cycleActions
 * MAGUK a végrehajtott profit-ciklus trade-ek (kind = origin); az AI-trade 'ai' eredettel
 * a végükre kerül. Nincs IO/Date/Math.random.
 */
export function buildTickProcess(input: TickProcessInput): TickProcess {
  const cycleTrades = input.cycleActions.map((a) => ({
    symbol: a.symbol,
    side: a.side,
    origin: a.kind as TradeOrigin,
    amountUsd: a.amountUsd ?? 0,
  }));
  const aiTrades = input.aiTrade
    ? [{ symbol: input.aiTrade.symbol, side: input.aiTrade.side, origin: "ai" as TradeOrigin, amountUsd: input.aiTrade.amountUsd }]
    : [];
  return {
    tickId: input.tickId,
    inputs: { prices: input.prices, fearGreed: input.fearGreed, mlSignals: input.mlSignals },
    cycleActions: input.cycleActions.map((a) => ({ kind: a.kind, side: a.side, symbol: a.symbol, qty: a.qty, amountUsd: a.amountUsd })),
    phase1: input.phase1,
    phase2: input.phase2,
    decision: input.decision,
    trades: [...cycleTrades, ...aiTrades],
  };
}
```

- [ ] **Step 4: Futtasd, ellenőrizd hogy ÁTMEGY**

Run: `pnpm vitest run tests/lib/engine/tick-process.test.ts`
Expected: PASS (2 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/tick-process.ts tests/lib/engine/tick-process.test.ts
git commit -m "feat(engine): TickProcess típus + tiszta buildTickProcess (TDD)"
```

---

## Task 3: Perzisztencia bekötése — trade-eredet + tick_runs napló

**Files:**
- Modify: `src/lib/types.ts:54-65` (`Trade` típus)
- Modify: `src/lib/portfolio/accounting.ts` (`applyTrade` origin-beírás + új `insertTickRun`)
- Modify: `src/lib/engine/tick.ts` (`executeCycleOrder` + AI-ág origin; phase2 hoist; `TickResult.process`)
- Modify: `src/lib/engine/run-scheduled-tick.ts` (`insertTickRun` hívás)
- Test: `tests/lib/portfolio/tick-run-persist.test.ts` (új)

**Interfaces:**
- Consumes: `buildTickProcess`, `TickProcess`, `TradeOrigin` (Task 2); `schema.tickRuns`, `schema.trades.origin` (Task 1).
- Produces: `insertTickRun(tickId: string, process: TickProcess, dbOverride?: Db | null): Promise<void>`; `Trade.origin?: TradeOrigin`; `TickResult.process: TickProcess`.

- [ ] **Step 1: Írd meg a bukó tesztet (insertTickRun)**

`tests/lib/portfolio/tick-run-persist.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { insertTickRun } from "@/lib/portfolio/accounting";
import type { TickProcess } from "@/lib/engine/tick-process";

const proc: TickProcess = {
  tickId: "2026-06-28-11",
  inputs: { prices: { BTC: 60000 }, fearGreed: null, mlSignals: [] },
  cycleActions: [],
  phase1: { shouldDecide: false, summary: "x" },
  phase2: null,
  decision: { action: "HOLD", symbol: null, overridden: false, overrideReason: null },
  trades: [],
};

describe("insertTickRun", () => {
  it("beszúrja a tickId + process párost a tick_runs-ba", async () => {
    let captured: unknown = null;
    const mockDb = { insert: () => ({ values: async (v: unknown) => { captured = v; } }) } as never;
    await insertTickRun("2026-06-28-11", proc, mockDb);
    expect(captured).toEqual({ tickId: "2026-06-28-11", process: proc });
  });

  it("DB nélkül (null) nem dob és nem csinál semmit", async () => {
    await expect(insertTickRun("x", proc, null)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Futtasd, ellenőrizd hogy BUKIK**

Run: `pnpm vitest run tests/lib/portfolio/tick-run-persist.test.ts`
Expected: FAIL — `insertTickRun` még nincs exportálva.

- [ ] **Step 3: `Trade.origin` mező**

`src/lib/types.ts` — a `Trade` interfész `mode` sora UTÁN:
```ts
  /** Mi hajtotta a trade-et: profit-ciklus (dca/stop-loss/take-profit) vagy AI. */
  origin?: import("@/lib/engine/tick-process").TradeOrigin;
```

- [ ] **Step 4: `applyTrade` írja az origin-t + új `insertTickRun`**

`src/lib/portfolio/accounting.ts` — a `db.insert(schema.trades).values({...})` (≈230. sor) bővítése a `mode` után:
```ts
      mode: trade.mode,
      origin: trade.origin ?? null,
```

`src/lib/portfolio/accounting.ts` — a fájl végéhez (a `firstPortfolioId` mellé) add hozzá. (A `TickProcess` import a fájl tetejére: `import type { TickProcess } from "@/lib/engine/tick-process";`.)
```ts
/** Best-effort: a tickenkénti folyamat-pillanatkép naplózása. DB-hiba nem buktatja a ticket. */
export async function insertTickRun(
  tickId: string,
  process: TickProcess,
  dbOverride?: Db | null,
): Promise<void> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return;
  try {
    await db.insert(schema.tickRuns).values({ tickId, process });
  } catch (e) {
    console.error("[accounting] insertTickRun hiba:", e);
  }
}
```

- [ ] **Step 5: Futtasd az insertTickRun tesztet → ÁTMEGY**

Run: `pnpm vitest run tests/lib/portfolio/tick-run-persist.test.ts`
Expected: PASS (2 teszt).

- [ ] **Step 6: `tick.ts` — origin a trade-ekre + phase2 hoist + process építése**

(a) `executeCycleOrder` kapjon `origin` paramétert. A szignatúra (≈188. sor) bővítése:
```ts
  const executeCycleOrder = async (
    side: "BUY" | "SELL",
    symbol: string,
    opts: { qty?: number; amountUsd?: number },
    price: number,
    origin: "dca" | "stop-loss" | "take-profit",
  ): Promise<Trade | null> => {
```
Az `if (!trade) return null;` UTÁN, az `applyTrade` ELŐTT írd be az eredetet:
```ts
    if (!trade) return null;
    trade.origin = origin;
```
A hívásoknál (≈322-325. sor) add át a `o.kind`-ot:
```ts
      const trade =
        o.side === "SELL"
          ? await executeCycleOrder("SELL", o.symbol, { qty: o.qty }, o.triggerPrice ?? px, o.kind)
          : await executeCycleOrder("BUY", o.symbol, { amountUsd: o.amountUsd }, px, o.kind);
```

(b) Az AI-ág (≈423. sor) az `applyTrade` ELŐTT jelölje meg:
```ts
      trade = await broker.execute(order, price);
      if (trade) trade.origin = "ai";
```

(c) phase2 hoist + process építése. A `let rawDecision` (≈349. sor) MELLÉ:
```ts
  let phase2Snapshot: import("@/lib/engine/tick-process").TickProcess["phase2"] = null;
```
A `phase2` blokkban (≈372. sor, a `rawDecision = {...}` után) töltsd:
```ts
    phase2Snapshot = {
      action: phase2.action,
      symbol: phase2.symbol ?? null,
      amountPct: phase2.amountPct,
      confidence: phase2.confidence,
      reasoning: phase2.reasoning,
    };
```
A `return {` (≈436. sor) ELŐTT építsd a process-t (a `fgEvent`/F&G a profit-ciklus blokkban scope-olt — itt újra kiolvassuk az events-ből):
```ts
  const fgForProcess = events.find((e) => e.kind === "sentiment" && e.sentiment)?.sentiment ?? null;
  const process = buildTickProcess({
    tickId: input.tickId,
    prices,
    fearGreed: fgForProcess ? { value: fgForProcess.value, classification: fgForProcess.classification } : null,
    mlSignals: mlSignals.map((s) => ({ symbol: s.symbol, direction1h: s.direction1h, confidence: s.confidence })),
    cycleActions,
    phase1: { shouldDecide: phase1.shouldDecide, summary: phase1.summary },
    phase2: phase2Snapshot,
    decision: {
      action: decision.action,
      symbol: decision.symbol || null,
      overridden: decision.overridden,
      overrideReason: decision.overrideReason ?? null,
    },
    aiTrade: trade ? { symbol: trade.symbol, side: trade.side, amountUsd: trade.amountUsd } : null,
  });
```
Add a `process`-t a return objektumhoz:
```ts
    cycleActions,
    process,
  };
```
A `TickResult` interfész (≈42. sor) bővítése:
```ts
  /** A tick teljes folyamat-pillanatképe (átláthatóság, tick_runs napló). */
  process: import("@/lib/engine/tick-process").TickProcess;
```
Import a fájl tetejére: `import { buildTickProcess } from "@/lib/engine/tick-process";`

⚠️ A `sentiment` objektum mezőit (`value`, `classification`) ellenőrizd a `DataPoint` típusban; ha a classification máshogy hívódik, igazítsd.

- [ ] **Step 7: `run-scheduled-tick.ts` — napló beszúrása**

`src/lib/engine/run-scheduled-tick.ts` — a 3) blokk `try`-jában, az `evaluatePending(result.prices);` UTÁN:
```ts
        await evaluatePending(result.prices);
        // Folyamat-napló (átláthatóság) — best-effort.
        await insertTickRun(tickId, result.process);
```
Import: `import { evaluatePending } from "@/lib/portfolio/evaluate";` mellé:
```ts
import { insertTickRun } from "@/lib/portfolio/accounting";
```

- [ ] **Step 8: Teljes suite + tsc**

Run: `pnpm vitest run`
Expected: PASS — minden teszt zöld (a meglévő tick/profit-cycle tesztek is, mert az origin opcionális és az `applyTrade` mock ignorálja).

Run: `pnpm exec tsc --noEmit` → 0 hiba.

- [ ] **Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/portfolio/accounting.ts src/lib/engine/tick.ts src/lib/engine/run-scheduled-tick.ts tests/lib/portfolio/tick-run-persist.test.ts
git commit -m "feat(engine): trade-eredet (origin) + tick_runs napló perzisztálása (best-effort)"
```

---

## Task 4: API — `/api/ticks` + `/api/market` config-bővítés

**Files:**
- Create: `src/app/api/ticks/route.ts`
- Modify: `src/app/api/market/route.ts:69-78` (config-bővítés)

**Interfaces:**
- Consumes: `schema.tickRuns` (Task 1), `DEFAULT_STRATEGY` (`@/lib/strategy/config`).
- Produces: `GET /api/ticks?limit=N` → `{ ticks: { id, ts, tickId, process }[] }`; a `/api/market` `config` +`entryFilter`, +`takeProfitFraction`.

- [ ] **Step 1: `/api/ticks` route**

`src/app/api/ticks/route.ts`:
```ts
import { NextResponse } from "next/server";
import { getDb, schema } from "@/db/client";
import { desc } from "drizzle-orm";

// Élő napló-adat → on-demand, nem prerenderelhető.
export const dynamic = "force-dynamic";

/** A legutóbbi tick-folyamatok (átláthatóság). DB nélkül üres lista. */
export async function GET(req: Request) {
  const db = getDb();
  if (!db) return NextResponse.json({ ticks: [], note: "DATABASE_URL hiányzik." });
  try {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? "20");
    const rows = await db.query.tickRuns.findMany({
      limit: Math.min(limit, 100),
      orderBy: desc(schema.tickRuns.ts),
    });
    return NextResponse.json({ ticks: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/ticks]", e);
    return NextResponse.json({ ticks: [], error: "DB hiba" }, { status: 500 });
  }
}
```
⚠️ Ha a `db.query.tickRuns` nem elérhető (a drizzle `query` API a `schema`-ból generál relations-t), használd a `db.select().from(schema.tickRuns).orderBy(desc(...)).limit(...)` formát helyette.

- [ ] **Step 2: `/api/market` config-bővítés**

`src/app/api/market/route.ts` — a `config` objektumba (a `dcaBuyPct` után):
```ts
          dcaBuyPct: PROFIT_CYCLE.dcaBuyPct,
          entryFilter: DEFAULT_STRATEGY.entryFilter,
          takeProfitFraction: DEFAULT_STRATEGY.takeProfitFraction,
```
Import a fájl tetejére:
```ts
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
```

- [ ] **Step 3: tsc + build + smoke**

Run: `pnpm exec tsc --noEmit` → 0 hiba.
Run: `pnpm build` → zöld.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/ticks/route.ts src/app/api/market/route.ts
git commit -m "feat(api): /api/ticks napló-végpont + /api/market config (entryFilter, takeProfitFraction)"
```

---

## Task 5: Megjelenítés — trade-eredet badge + StrategyPanel + DecisionDetail

**Files:**
- Modify: `src/components/TradeBlotter.tsx` (origin badge)
- Modify: `src/components/RiskPanel.tsx` (`RiskConfig` típus +`entryFilter`, +`takeProfitFraction`)
- Create: `src/components/StrategyPanel.tsx`
- Modify: `src/components/DecisionCard.tsx` (`DecisionRow` +`ref`) + `src/components/DecisionDetail.tsx` (ref-árak)
- Modify: `src/components/Dashboard.tsx` (StrategyPanel beillesztése)

**Interfaces:**
- Consumes: `/api/portfolio` `recentTrades[].origin` (Task 1/3 óta automatikus), `/api/market` `config` (Task 4).
- Produces: vizuális badge + panel + gazdagabb részlet.

- [ ] **Step 1: TradeBlotter eredet-badge**

`src/components/TradeBlotter.tsx` — a `BlotterTrade` interfészbe:
```ts
  origin?: string | null;
```
A `mode` melletti cellába (a `t.side` után) tegyél badge-et. A `<span className={buy ? "text-up" : "text-down"}>{t.side}</span>` UTÁN:
```tsx
              <OriginBadge origin={t.origin} />
```
És a komponens aljára:
```tsx
const ORIGIN: Record<string, { label: string; cls: string }> = {
  dca: { label: "DCA", cls: "text-accentBright" },
  "stop-loss": { label: "STOP", cls: "text-down" },
  "take-profit": { label: "TP", cls: "text-up" },
  ai: { label: "AI", cls: "text-dim" },
  manual: { label: "KÉZI", cls: "text-faint" },
};
function OriginBadge({ origin }: { origin?: string | null }) {
  const o = origin ? ORIGIN[origin] : null;
  return (
    <span className={`font-mono text-[9px] uppercase tracking-wider ${o?.cls ?? "text-faint"}`}>
      {o?.label ?? "—"}
    </span>
  );
}
```
A sor grid-jét igazítsd, hogy a badge elférjen: a `grid-cols-[auto_2.5rem_1fr_auto]` → `grid-cols-[auto_2.5rem_2.5rem_1fr_auto]`.

- [ ] **Step 2: RiskConfig típus-bővítés**

`src/components/RiskPanel.tsx` — a `RiskConfig` típusba (opcionálisként, hogy a régi adat ne törjön):
```ts
  entryFilter?: "off" | "trend";
  takeProfitFraction?: number;
```

- [ ] **Step 3: StrategyPanel**

`src/components/StrategyPanel.tsx`:
```tsx
"use client";

import type { RiskConfig } from "./RiskPanel";

/** Statikus magyarázó: MIT csinál a hangolt stratégia (emberi nyelvű szabály-lista). */
export function StrategyPanel({ config }: { config: RiskConfig | null }) {
  if (!config) return null;
  const pct = (n?: number) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
  const rules: [string, string][] = [
    ["Belépő-szűrő", config.entryFilter === "trend" ? "BE — csak emelkedő trendben vásárol (SMA24)" : "KI"],
    ["Take-profit", `+${pct(config.takeProfitPct)} → ${config.takeProfitFraction === 1 ? "teljes" : "fél"} pozíció zárása`],
    ["DCA (halmozás)", `Fear & Greed ≤ ${config.dcaFgThreshold} esetén ${pct(config.dcaBuyPct)} vétel, heti ${pct(config.dcaWeeklyBudgetPct)} keret`],
    ["Stop-loss", `−${pct(config.stopLossPct)} (trailing: emelkedéskor felfelé kúszik)`],
    ["Max pozíció", `${pct(config.maxPositionPct)} tőke / coin, max ${config.maxConcurrentPositions} egyszerre`],
    ["Napi circuit breaker", `−${pct(config.dailyLossCircuitBreakerPct)} alatt új vétel tiltva`],
  ];
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
        Stratégia — a bot szabályai
      </h2>
      <dl className="mt-3 space-y-2">
        {rules.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 border-b border-line/40 pb-2 last:border-0">
            <dt className="font-mono text-[10px] uppercase tracking-wider text-faint">{k}</dt>
            <dd className="font-sans text-[12.5px] text-dim">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
```

- [ ] **Step 4: DecisionDetail — ref-árak**

`src/components/DecisionCard.tsx` — a `DecisionRow` interfészbe:
```ts
  ref?: { prices?: Record<string, number> } | null;
```
`src/components/DecisionDetail.tsx` — a `rows` tömb után, a `prices` megjelenítése (ha van):
```tsx
  const refPrices = d.ref?.prices ?? null;
```
A `</dl>` UTÁN (a komponens return-jében, a `dl` testvéreként egy fragmentben):
```tsx
      {refPrices && (
        <p className="mt-2 font-mono text-[10px] text-faint">
          döntéskori ár: {Object.entries(refPrices).map(([s, p]) => `${s} $${p.toFixed(0)}`).join(" · ")}
        </p>
      )}
```
(A return-t alakítsd `<>...</>` fragmentté, ha eddig egyetlen `<dl>` volt.)

- [ ] **Step 5: Dashboard — StrategyPanel beillesztése**

`src/components/Dashboard.tsx` — import:
```ts
import { StrategyPanel } from "./StrategyPanel";
```
A jobb oldali oszlopba (a `RiskPanel` után, ≈151. sor):
```tsx
            <RiskPanel config={market?.config ?? null} weeklyBudgetRemainingUsd={market?.weeklyBudgetRemainingUsd ?? null} />
            <StrategyPanel config={market?.config ?? null} />
```

- [ ] **Step 6: tsc + build + vizuális verifikáció**

Run: `pnpm exec tsc --noEmit` → 0 hiba.
Run: `pnpm build` → zöld.
Run: `pnpm dev`, nyisd meg `http://localhost:3000` — ellenőrizd: a trade-naplóban eredet-badge (DCA/STOP/TP/AI), és a jobb oszlopban a StrategyPanel a hangolt szabályokkal. (A badge a migráció UTÁN keletkezett trade-eken jelenik meg; a régieken „—".)

- [ ] **Step 7: Commit**

```bash
git add src/components/TradeBlotter.tsx src/components/RiskPanel.tsx src/components/StrategyPanel.tsx src/components/DecisionCard.tsx src/components/DecisionDetail.tsx src/components/Dashboard.tsx
git commit -m "feat(ui): trade-eredet badge + StrategyPanel + döntéskori ár a részletben"
```

---

## Task 6: `TickInspector` — a tickenkénti teljes lánc

**Files:**
- Create: `src/components/TickInspector.tsx`
- Modify: `src/components/Dashboard.tsx` (TickInspector beillesztése)

**Interfaces:**
- Consumes: `GET /api/ticks` (Task 4) → `{ ticks: { id, ts, tickId, process: TickProcess }[] }`.
- Produces: vizuális lánc-nézet.

- [ ] **Step 1: TickInspector komponens**

`src/components/TickInspector.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import type { TickProcess } from "@/lib/engine/tick-process";

interface TickRow {
  id: string;
  ts: string;
  tickId: string;
  process: TickProcess;
}

/** A kiválasztott tick TELJES lánca: inputok → ML → profit-ciklus → phase1 → phase2 → risk → végrehajtás. */
export function TickInspector() {
  const [ticks, setTicks] = useState<TickRow[]>([]);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const load = () =>
      fetch("/api/ticks?limit=20", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setTicks(d.ticks ?? []))
        .catch(() => setTicks([]));
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const t = ticks[sel]?.process;

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-accent">
          Tick-inspector — a teljes lánc
        </h2>
        {ticks.length > 0 && (
          <select
            className="rounded border border-line bg-panel2 px-2 py-1 font-mono text-[11px] text-dim"
            value={sel}
            onChange={(e) => setSel(Number(e.target.value))}
          >
            {ticks.map((r, i) => (
              <option key={r.id} value={i}>{r.tickId}</option>
            ))}
          </select>
        )}
      </div>

      {!t && <p className="mt-5 font-mono text-xs text-faint">Még nincs naplózott tick. Az első tick (a napló élesítése) után jelenik meg.</p>}

      {t && (
        <ol className="mt-4 space-y-2">
          <Step n="1" title="Inputok" fired>
            {Object.entries(t.inputs.prices).map(([s, p]) => `${s} $${p.toFixed(0)}`).join(" · ")}
            {t.inputs.fearGreed ? ` · F&G ${t.inputs.fearGreed.value} (${t.inputs.fearGreed.classification})` : ""}
          </Step>
          <Step n="2" title="ML-jel" fired={t.inputs.mlSignals.length > 0}>
            {t.inputs.mlSignals.map((s) => `${s.symbol} ${s.direction1h} ${(s.confidence * 100).toFixed(0)}%`).join(" · ") || "nincs jel"}
          </Step>
          <Step n="3" title="Profit-ciklus" fired={t.cycleActions.length > 0}>
            {t.cycleActions.map((a) => `${a.kind.toUpperCase()} ${a.side} ${a.symbol}${a.amountUsd ? ` $${a.amountUsd.toFixed(0)}` : ""}`).join(" · ") || "nincs akció (stop/TP/DCA nem tüzelt)"}
          </Step>
          <Step n="4" title="Phase-1 (AI szűrő)" fired={t.phase1.shouldDecide}>
            {t.phase1.shouldDecide ? "döntésre érdemes" : "kihagyva"} — {t.phase1.summary}
          </Step>
          <Step n="5" title="Phase-2 (AI döntés)" fired={!!t.phase2}>
            {t.phase2 ? `${t.phase2.action} ${t.phase2.symbol ?? ""} (${(t.phase2.confidence * 100).toFixed(0)}%) — ${t.phase2.reasoning}` : "nem hívva (phase-1 nemet mondott)"}
          </Step>
          <Step n="6" title="Risk Manager" fired={t.decision.overridden}>
            {t.decision.overridden ? `módosítva → ${t.decision.action} (${t.decision.overrideReason})` : "változatlanul átengedve"}
          </Step>
          <Step n="7" title="Végrehajtás" fired={t.trades.length > 0}>
            {t.trades.map((tr) => `${tr.origin.toUpperCase()} ${tr.side} ${tr.symbol} $${tr.amountUsd.toFixed(0)}`).join(" · ") || "nincs trade"}
          </Step>
        </ol>
      )}
    </section>
  );
}

function Step({ n, title, fired, children }: { n: string; title: string; fired?: boolean; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_8rem_1fr] items-start gap-2 border-b border-line/40 pb-2 last:border-0">
      <span className={`font-mono text-[11px] ${fired ? "text-accentBright" : "text-faint"}`}>{n}</span>
      <span className={`font-mono text-[11px] uppercase tracking-wider ${fired ? "text-dim" : "text-faint"}`}>{title}</span>
      <span className={`font-sans text-[12px] ${fired ? "text-ink/90" : "text-faint"}`}>{children}</span>
    </li>
  );
}
```

- [ ] **Step 2: Dashboard — TickInspector beillesztése**

`src/components/Dashboard.tsx` — import:
```ts
import { TickInspector } from "./TickInspector";
```
A backtest/admin rács ELÉ (≈161. sor, a „Backtest + admin" blokk fölé) egy teljes szélességű sorba:
```tsx
        <TickInspector />

        {/* ── Backtest + admin ── */}
```

- [ ] **Step 3: tsc + build + vizuális verifikáció**

Run: `pnpm exec tsc --noEmit` → 0 hiba.
Run: `pnpm build` → zöld.
Run: `pnpm dev` → `http://localhost:3000` — a TickInspector mutatja a legutóbbi tick 7-lépéses láncát; a tick-választó váltja a tickeket. (Tartalom az első naplózott tick után jelenik meg.)

- [ ] **Step 4: Commit**

```bash
git add src/components/TickInspector.tsx src/components/Dashboard.tsx
git commit -m "feat(ui): TickInspector — a tickenkénti teljes döntési lánc"
```

---

## Task 7: Teljes kapu + élesítés

**Files:** nincs új; kapu-futtatás.

- [ ] **Step 1: Teszt-kapu**

Run: `pnpm vitest run`
Expected: PASS — minden teszt zöld (a Task 1/2/3 új tesztjeivel, ≈153).

- [ ] **Step 2: Típus + build kapu**

Run: `pnpm exec tsc --noEmit` → 0 hiba.
Run: `pnpm build` → zöld.

- [ ] **Step 3: Migráció-ellenőrzés (a DB készen áll-e)**

Ellenőrizd, hogy a Task 1 migrációja lefutott a DB-re (a `tick_runs` tábla + `trades.origin` létezik). Ha bizonytalan: futtasd újra `pnpm db:migrate` (idempotens).

- [ ] **Step 4: Élesítés + mérés (kézi, a felhasználó lépése)**

- A felhasználó **kézzel pushol** master-re. A GitHub runner a következő `:07`-es tickkor már naplóz (`insertTickRun`) és origin-nel ír trade-et.
- Pár tick után a prod dashboard (`https://trade-beryl-six.vercel.app`) mutatja: TickInspector lánc, trade-eredet badge, StrategyPanel.

---

## Self-Review (kitöltve)

**Spec-lefedettség:**
- Spec §3.1 (`trades.origin`) → Task 1. ✓
- Spec §3.2-3.3 (`tick_runs` + `TickProcess`) → Task 1 (tábla) + Task 2 (típus). ✓
- Spec §4.1 (`buildTickProcess`) → Task 2. ✓
- Spec §4.2 (origin-levezetés) → Task 2 (cycle kind→origin a buildben) + Task 3 (live `Trade.origin` = `o.kind`/`"ai"`). ✓
- Spec §4.3 (`insertTickRun`) + §4.4 (`applyTrade` origin) → Task 3. ✓
- Spec §5 (API: /api/ticks, market config; portfolio origin AUTOMATIKUS a findMany-vel) → Task 4 (+ Task 5 a BlotterTrade típus). ✓
- Spec §6 (UI: TradeBlotter, TickInspector, DecisionDetail, StrategyPanel) → Task 5 + Task 6. ✓
- Spec §8 (best-effort hibakezelés) → Task 3 (`insertTickRun`/`applyTrade` try-catch). ✓
- Spec §9 (tesztelés: buildTickProcess + insertTickRun TDD, UI vizuális) → Task 2, 3, 5-6. ✓
- Spec §10 (migráció) → Task 1 Step 5. ✓
- Spec §12 (siker-kritérium) → Task 7. ✓

**Placeholder-ellenőrzés:** minden lépés valódi kód. A két `⚠️` (sentiment mezőnevek, `db.query` vs `db.select`) **konkrét fallbackot ad**, nem placeholder — a környezet-függő drizzle-API két ismert alakjára.

**Típus-konzisztencia:** `TradeOrigin`/`TickProcess`/`TickProcessInput`/`buildTickProcess` Task 2-ben definiálva; Task 3 (`insertTickRun(tickId, process, dbOverride?)`, `Trade.origin`, `TickResult.process`) és Task 4-6 ezeket fogyasztják azonos nevekkel. A `process.trades[].origin` és a `trades.origin` oszlop ugyanazt a `TradeOrigin` uniót használja.

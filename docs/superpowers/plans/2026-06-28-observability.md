# Observability (liveness-riasztó + realized analitika) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Egy dead-man's-switch heartbeat, ami riaszt, ha a bot némán elhal; (B) a valódi (realized) kereskedési teljesítmény láthatóvá tétele (closed-trade ledger + bontások + realized equity-görbe).

**Architecture:** Két független, kis modul. (A) `ops/heartbeat.ts` egy best-effort `pingHeartbeat()`-tel, bekötve a közös `executeScheduledTick`-be (siker→ping, hiba→`/fail`); a riasztás-szolgáltatás külső (healthchecks.io). (B) `portfolio/analytics.ts` tiszta aggregáló magokkal (a `positions`+`trades`-ből) + vékony DB-wrapperek + `/api/analytics` route + `AnalyticsPanel` a dashboardba. Minden DB-érintő kód best-effort (hiba → biztonságos default, nem dob).

**Tech Stack:** TypeScript 5.5, Vitest 2.0, Drizzle ORM (Neon), Next 14 App Router, React 18.

## Global Constraints

- Minden DB-olvasó fv **best-effort**: `getDb()` null vagy hiba → biztonságos default (üres/null), **sosem dob**.
- A `pingHeartbeat` **env nélkül no-op** (`HEARTBEAT_URL` nincs → semmi); a ping SOHA nem akaszthatja meg a ticket (teljes try/catch).
- Új API-route: `export const dynamic = "force-dynamic"` + `runtime = "nodejs"` + `Cache-Control: no-store` (a `ticks`/`market` route mintára, a Neon-cache gotcha miatt).
- **TDD** a tiszta magokra (heartbeat helper + analytics aggregátorok) az implementáció ELŐTT.
- A meglévő **171 teszt zöld marad**; kapu: `pnpm vitest run` + `pnpm exec tsc --noEmit` (0) + `pnpm build` zöld.
- Drizzle: a sémanevek `@/db/client`-ből (`getDb`, `schema`); a timestamp-mezők (`openedAt`, `closedAt`, `executedAt`) **`Date` objektumként** jönnek vissza.

---

## File Structure

- **Create** `src/lib/ops/heartbeat.ts` — `pingHeartbeat(ok)` best-effort dead-man's-switch ping.
- **Create** `tests/lib/ops/heartbeat.test.ts`
- **Modify** `src/lib/engine/run-scheduled-tick.ts` — `pingHeartbeat(true)` sikerkor, `pingHeartbeat(false)` a catch-ben.
- **Create** `src/lib/portfolio/analytics.ts` — tiszta magok (`summarizeClosedPosition`, `computeBreakdowns`, `computeEquityCurve`) + DB-wrapperek (`getClosedTrades`, `getBreakdowns`, `getRealizedEquityCurve`).
- **Create** `tests/lib/portfolio/analytics.test.ts`
- **Create** `src/app/api/analytics/route.ts` — a három wrapper eredménye JSON-ban.
- **Create** `src/components/AnalyticsPanel.tsx` + **Modify** `src/components/Dashboard.tsx` — a panel bekötése.

---

## Task 1: Liveness — heartbeat helper + bekötés + setup-doc

**Files:**
- Create: `src/lib/ops/heartbeat.ts`
- Test: `tests/lib/ops/heartbeat.test.ts`
- Modify: `src/lib/engine/run-scheduled-tick.ts`

**Interfaces:**
- Produces: `pingHeartbeat(ok: boolean): Promise<void>` — best-effort. `HEARTBEAT_URL` env nincs → no-op. Van → `fetch(ok ? url : \`${url}/fail\`)`; bármilyen hiba elnyelve.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/ops/heartbeat.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pingHeartbeat } from "@/lib/ops/heartbeat";

describe("pingHeartbeat", () => {
  beforeEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("env nélkül nem pingel", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await pingHeartbeat(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ok=true → az URL-t hívja", async () => {
    vi.stubEnv("HEARTBEAT_URL", "https://hc.example/abc");
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal("fetch", fetchMock);
    await pingHeartbeat(true);
    expect(fetchMock).toHaveBeenCalledWith("https://hc.example/abc");
  });

  it("ok=false → az URL/fail-t hívja", async () => {
    vi.stubEnv("HEARTBEAT_URL", "https://hc.example/abc");
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal("fetch", fetchMock);
    await pingHeartbeat(false);
    expect(fetchMock).toHaveBeenCalledWith("https://hc.example/abc/fail");
  });

  it("fetch-hibát elnyel (nem dob)", async () => {
    vi.stubEnv("HEARTBEAT_URL", "https://hc.example/abc");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    await expect(pingHeartbeat(true)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/ops/heartbeat.test.ts`
Expected: FAIL — `Cannot find module '@/lib/ops/heartbeat'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/ops/heartbeat.ts
/**
 * Dead-man's-switch heartbeat. A tick SIKERKOR pingeli a HEARTBEAT_URL-t; egy külső
 * szolgáltatás (pl. healthchecks.io) riaszt, ha a ping a grace-period alatt NEM érkezik
 * meg (= a bot elhallgatott). Best-effort: env nélkül no-op, hibát elnyel, SOHA nem dob.
 *
 * USER-SETUP (külső, egyszeri):
 *   1) healthchecks.io → új check: period 1h, grace ~90 perc (a GitHub-cron hézagaihoz).
 *   2) másold a ping-URL-t HEARTBEAT_URL néven a GitHub repo-secretek közé
 *      (Settings → Secrets → Actions) ÉS a Vercel env-be (production).
 *   3) állítsd be a riasztás-csatornát (e-mail) a healthchecks.io-n.
 * Amíg nincs beállítva, ez a kód csendben no-op — semmi nem törik.
 */
export async function pingHeartbeat(ok: boolean): Promise<void> {
  const url = process.env.HEARTBEAT_URL;
  if (!url) return;
  try {
    await fetch(ok ? url : `${url}/fail`);
  } catch (e) {
    console.error("[heartbeat] ping hiba:", e);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/ops/heartbeat.test.ts`
Expected: PASS (4 teszt).

- [ ] **Step 5: Wire into the scheduled tick**

`src/lib/engine/run-scheduled-tick.ts` — fent a többi import mellé:

```ts
import { pingHeartbeat } from "@/lib/ops/heartbeat";
```

A SIKERES ág `return`-je ELÉ (a `return { ok: true, tickId, decisionId, ... }` előtt):

```ts
    await pingHeartbeat(true);
    return {
      ok: true,
      tickId,
      decisionId,
      action: result.decision.action,
      overridden: result.decision.overridden,
      hasTrade: !!result.trade,
    };
```

A `catch (e)` ágban a `return`-je ELÉ (a `return { ok: false, tickId, error: String(e) }` előtt):

```ts
    console.error("[scheduled-tick] ciklus hiba:", e);
    await pingHeartbeat(false);
    return { ok: false, tickId, error: String(e) };
```

*(Megj.: a tesztekben a `HEARTBEAT_URL` nincs beállítva → `pingHeartbeat` no-op, a meglévő tick-tesztek érintetlenek.)*

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS (a meglévő 171 + 4 új) + 0 tsc hiba.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ops/heartbeat.ts tests/lib/ops/heartbeat.test.ts src/lib/engine/run-scheduled-tick.ts
git commit -m "feat(ops): dead-man's-switch heartbeat (env nélkül no-op, best-effort)"
```

---

## Task 2: Analitika — tiszta aggregáló magok

**Files:**
- Create: `src/lib/portfolio/analytics.ts`
- Test: `tests/lib/portfolio/analytics.test.ts`

**Interfaces:**
- Produces (típusok + tiszta fv-ek):
  - `ClosedTradeRow = { symbol: string; entryPrice: number; exitPrice: number; qtyClosed: number; pnlUsd: number; pnlPct: number; holdHours: number; exitOrigin: string; exitTs: number }`
  - `Breakdown = { key: string; trades: number; winRate: number; avgPnlPct: number }`
  - `Breakdowns = { byCoin: Breakdown[]; byExitOrigin: Breakdown[] }`
  - `EquityPoint = { ts: number; equityUsd: number }`
  - `summarizeClosedPosition(p: ClosedPos, posTrades: PosTrade[]): ClosedTradeRow` ahol `ClosedPos = { symbol: string; entryPrice: number; openedAt: Date; closedAt: Date }`, `PosTrade = { side: string; amountUsd: number; price: number; qty: number; feeUsd: number; origin: string | null; executedAt: Date }`.
  - `computeBreakdowns(rows: ClosedTradeRow[]): Breakdowns`
  - `computeEquityCurve(rows: ClosedTradeRow[], initialCapitalUsd: number): EquityPoint[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/portfolio/analytics.test.ts
import { describe, it, expect } from "vitest";
import { summarizeClosedPosition, computeBreakdowns, computeEquityCurve } from "@/lib/portfolio/analytics";

const d = (iso: string) => new Date(iso);

describe("summarizeClosedPosition", () => {
  it("round-trip P&L több BUY-jal + záró SELL origin", () => {
    const pos = { symbol: "BTC", entryPrice: 100, openedAt: d("2026-06-01T00:00:00Z"), closedAt: d("2026-06-01T05:00:00Z") };
    const trades = [
      { side: "BUY", amountUsd: 100, price: 100, qty: 1, feeUsd: 0.1, origin: "dca", executedAt: d("2026-06-01T00:00:00Z") },
      { side: "BUY", amountUsd: 100, price: 100, qty: 1, feeUsd: 0.1, origin: "dca", executedAt: d("2026-06-01T01:00:00Z") },
      { side: "SELL", amountUsd: 240, price: 120, qty: 2, feeUsd: 0.24, origin: "take-profit", executedAt: d("2026-06-01T05:00:00Z") },
    ];
    const r = summarizeClosedPosition(pos, trades);
    // buyCost=200, sellNet=240-0.24=239.76 → pnl=39.76
    expect(r.pnlUsd).toBeCloseTo(39.76, 2);
    expect(r.pnlPct).toBeCloseTo(39.76 / 200, 4);
    expect(r.qtyClosed).toBeCloseTo(2, 6);
    expect(r.exitPrice).toBeCloseTo(120, 6);
    expect(r.holdHours).toBeCloseTo(5, 6);
    expect(r.exitOrigin).toBe("take-profit");
  });

  it("nincs SELL → pnl = -buyCost, exitOrigin n/a", () => {
    const pos = { symbol: "ETH", entryPrice: 50, openedAt: d("2026-06-01T00:00:00Z"), closedAt: d("2026-06-01T01:00:00Z") };
    const trades = [{ side: "BUY", amountUsd: 50, price: 50, qty: 1, feeUsd: 0.05, origin: "dca", executedAt: d("2026-06-01T00:00:00Z") }];
    const r = summarizeClosedPosition(pos, trades);
    expect(r.pnlUsd).toBeCloseTo(-50, 6);
    expect(r.exitOrigin).toBe("n/a");
  });
});

describe("computeBreakdowns", () => {
  it("win-ráta + átlag pnl coin és exit-origin szerint", () => {
    const rows = [
      { symbol: "BTC", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: 10, pnlPct: 0.1, holdHours: 1, exitOrigin: "take-profit", exitTs: 1 },
      { symbol: "BTC", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: -5, pnlPct: -0.05, holdHours: 1, exitOrigin: "stop-loss", exitTs: 2 },
      { symbol: "ETH", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: 3, pnlPct: 0.03, holdHours: 1, exitOrigin: "take-profit", exitTs: 3 },
    ];
    const b = computeBreakdowns(rows);
    const btc = b.byCoin.find((x) => x.key === "BTC")!;
    expect(btc.trades).toBe(2);
    expect(btc.winRate).toBeCloseTo(0.5, 6);
    expect(btc.avgPnlPct).toBeCloseTo((0.1 - 0.05) / 2, 6);
    const tp = b.byExitOrigin.find((x) => x.key === "take-profit")!;
    expect(tp.trades).toBe(2);
    expect(tp.winRate).toBeCloseTo(1, 6);
  });
});

describe("computeEquityCurve", () => {
  it("kumulált realized P&L exit-idő szerint rendezve", () => {
    const rows = [
      { symbol: "BTC", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: 10, pnlPct: 0, holdHours: 0, exitOrigin: "tp", exitTs: 200 },
      { symbol: "ETH", entryPrice: 0, exitPrice: 0, qtyClosed: 0, pnlUsd: -4, pnlPct: 0, holdHours: 0, exitOrigin: "sl", exitTs: 100 },
    ];
    const curve = computeEquityCurve(rows, 100);
    expect(curve).toEqual([
      { ts: 100, equityUsd: 96 },
      { ts: 200, equityUsd: 106 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/portfolio/analytics.test.ts`
Expected: FAIL — `Cannot find module '@/lib/portfolio/analytics'`.

- [ ] **Step 3: Write minimal implementation** (csak a tiszta magok + típusok; a DB-wrapperek a Task 3)

```ts
// src/lib/portfolio/analytics.ts
export interface ClosedTradeRow {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  qtyClosed: number;
  pnlUsd: number;
  pnlPct: number;
  holdHours: number;
  exitOrigin: string;
  exitTs: number;
}
export interface Breakdown {
  key: string;
  trades: number;
  winRate: number;
  avgPnlPct: number;
}
export interface Breakdowns {
  byCoin: Breakdown[];
  byExitOrigin: Breakdown[];
}
export interface EquityPoint {
  ts: number;
  equityUsd: number;
}

interface ClosedPos {
  symbol: string;
  entryPrice: number;
  openedAt: Date;
  closedAt: Date;
}
interface PosTrade {
  side: string;
  amountUsd: number;
  price: number;
  qty: number;
  feeUsd: number;
  origin: string | null;
  executedAt: Date;
}

/** Egy lezárt pozíció round-trip összegzése a hozzá tartozó trade-ekből. Tiszta. */
export function summarizeClosedPosition(p: ClosedPos, posTrades: PosTrade[]): ClosedTradeRow {
  const buys = posTrades.filter((t) => t.side === "BUY");
  const sells = posTrades.filter((t) => t.side === "SELL");
  const buyCost = buys.reduce((s, t) => s + t.amountUsd, 0);
  const sellNet = sells.reduce((s, t) => s + (t.amountUsd - t.feeUsd), 0);
  const qtyClosed = sells.reduce((s, t) => s + t.qty, 0);
  const exitPrice = qtyClosed > 0 ? sells.reduce((s, t) => s + t.price * t.qty, 0) / qtyClosed : 0;
  const pnlUsd = sellNet - buyCost;
  const pnlPct = buyCost > 0 ? pnlUsd / buyCost : 0;
  const holdHours = (p.closedAt.getTime() - p.openedAt.getTime()) / 3_600_000;
  const lastSell = sells.length
    ? sells.reduce((a, b) => (a.executedAt.getTime() > b.executedAt.getTime() ? a : b))
    : null;
  return {
    symbol: p.symbol,
    entryPrice: p.entryPrice,
    exitPrice,
    qtyClosed,
    pnlUsd,
    pnlPct,
    holdHours,
    exitOrigin: lastSell?.origin ?? "n/a",
    exitTs: p.closedAt.getTime(),
  };
}

function aggregate(rows: ClosedTradeRow[], keyFn: (r: ClosedTradeRow) => string): Breakdown[] {
  const groups = new Map<string, { trades: number; wins: number; sumPnlPct: number }>();
  for (const r of rows) {
    const k = keyFn(r);
    const g = groups.get(k) ?? { trades: 0, wins: 0, sumPnlPct: 0 };
    g.trades += 1;
    if (r.pnlUsd > 0) g.wins += 1;
    g.sumPnlPct += r.pnlPct;
    groups.set(k, g);
  }
  return Array.from(groups.entries()).map(([key, g]) => ({
    key,
    trades: g.trades,
    winRate: g.trades ? g.wins / g.trades : 0,
    avgPnlPct: g.trades ? g.sumPnlPct / g.trades : 0,
  }));
}

export function computeBreakdowns(rows: ClosedTradeRow[]): Breakdowns {
  return { byCoin: aggregate(rows, (r) => r.symbol), byExitOrigin: aggregate(rows, (r) => r.exitOrigin) };
}

export function computeEquityCurve(rows: ClosedTradeRow[], initialCapitalUsd: number): EquityPoint[] {
  const sorted = [...rows].sort((a, b) => a.exitTs - b.exitTs);
  let eq = initialCapitalUsd;
  return sorted.map((r) => {
    eq += r.pnlUsd;
    return { ts: r.exitTs, equityUsd: eq };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/portfolio/analytics.test.ts`
Expected: PASS (4 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/analytics.ts tests/lib/portfolio/analytics.test.ts
git commit -m "feat(analytics): realized closed-trade aggregáló magok (TDD)"
```

---

## Task 3: Analitika — DB-wrapperek

**Files:**
- Modify: `src/lib/portfolio/analytics.ts`
- Test: `tests/lib/portfolio/analytics.test.ts`

**Interfaces:**
- Consumes: `summarizeClosedPosition`, `computeBreakdowns`, `computeEquityCurve` (Task 2).
- Produces: `getClosedTrades(dbOverride?): Promise<ClosedTradeRow[]>`, `getBreakdowns(dbOverride?): Promise<Breakdowns>`, `getRealizedEquityCurve(dbOverride?): Promise<EquityPoint[]>`. `dbOverride === null` → üres/biztonságos default (DB nélkül tesztelhető).

- [ ] **Step 1: Write the failing test** (a null-DB ág — biztonságos default, nem dob)

```ts
// tests/lib/portfolio/analytics.test.ts — ADD (a meglévő importot bővítsd:)
// import { ..., getClosedTrades, getBreakdowns, getRealizedEquityCurve } from "@/lib/portfolio/analytics";

describe("DB-wrapperek (null DB → biztonságos default)", () => {
  it("getClosedTrades null DB → []", async () => {
    expect(await getClosedTrades(null)).toEqual([]);
  });
  it("getBreakdowns null DB → üres bontások", async () => {
    expect(await getBreakdowns(null)).toEqual({ byCoin: [], byExitOrigin: [] });
  });
  it("getRealizedEquityCurve null DB → []", async () => {
    expect(await getRealizedEquityCurve(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/portfolio/analytics.test.ts`
Expected: FAIL — `getClosedTrades is not a function` / nincs exportálva.

- [ ] **Step 3: Write minimal implementation** — told a `src/lib/portfolio/analytics.ts` ALJÁRA:

```ts
import { getDb, schema } from "@/db/client";
import { isNotNull, inArray } from "drizzle-orm";

type Db = ReturnType<typeof getDb>;

export async function getClosedTrades(dbOverride?: Db | null): Promise<ClosedTradeRow[]> {
  const db = dbOverride !== undefined ? dbOverride : getDb();
  if (!db) return [];
  try {
    const positions = await db
      .select()
      .from(schema.positions)
      .where(isNotNull(schema.positions.closedAt));
    if (positions.length === 0) return [];
    const ids = positions.map((p) => p.id);
    const tradeRows = await db.select().from(schema.trades).where(inArray(schema.trades.positionId, ids));
    const byPos = new Map<string, PosTrade[]>();
    for (const t of tradeRows) {
      if (!t.positionId) continue;
      const arr = byPos.get(t.positionId) ?? [];
      arr.push({
        side: t.side,
        amountUsd: t.amountUsd,
        price: t.price,
        qty: t.qty,
        feeUsd: t.feeUsd,
        origin: t.origin,
        executedAt: t.executedAt,
      });
      byPos.set(t.positionId, arr);
    }
    return positions.map((p) =>
      summarizeClosedPosition(
        { symbol: p.symbol, entryPrice: p.entryPrice, openedAt: p.openedAt, closedAt: p.closedAt! },
        byPos.get(p.id) ?? [],
      ),
    );
  } catch (e) {
    console.error("[analytics] getClosedTrades hiba:", e);
    return [];
  }
}

export async function getBreakdowns(dbOverride?: Db | null): Promise<Breakdowns> {
  return computeBreakdowns(await getClosedTrades(dbOverride));
}

export async function getRealizedEquityCurve(dbOverride?: Db | null): Promise<EquityPoint[]> {
  const rows = await getClosedTrades(dbOverride);
  const db = dbOverride !== undefined ? dbOverride : getDb();
  let initial = 100;
  if (db) {
    try {
      const [p] = await db.select().from(schema.portfolios).limit(1);
      if (p) initial = p.initialCapitalUsd;
    } catch (e) {
      console.error("[analytics] equity initial hiba:", e);
    }
  }
  return computeEquityCurve(rows, initial);
}
```

*(A `PosTrade` interfész a Task 2-ben fájl-privát; mivel a wrapperek ugyanabban a fájlban vannak, elérhetők. A `Db` típus a `getDb` visszatérése.)*

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run tests/lib/portfolio/analytics.test.ts && npx tsc --noEmit`
Expected: PASS (7 teszt) + 0 tsc hiba.

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/analytics.ts tests/lib/portfolio/analytics.test.ts
git commit -m "feat(analytics): DB-wrapperek (getClosedTrades/Breakdowns/EquityCurve, best-effort)"
```

---

## Task 4: `/api/analytics` route

**Files:**
- Create: `src/app/api/analytics/route.ts`

**Interfaces:**
- Consumes: `getClosedTrades`, `getBreakdowns`, `getRealizedEquityCurve` (Task 3).

- [ ] **Step 1: Write the route** (a `ticks` route mintára; nincs külön unit-teszt — a wrapperek tesztelve, a route vékony)

```ts
// src/app/api/analytics/route.ts
import { NextResponse } from "next/server";
import { getClosedTrades, getBreakdowns, getRealizedEquityCurve } from "@/lib/portfolio/analytics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Realized teljesítmény: lezárt trade-ek + bontások + equity-görbe. DB nélkül üres. */
export async function GET() {
  try {
    const [closedTrades, breakdowns, equityCurve] = await Promise.all([
      getClosedTrades(),
      getBreakdowns(),
      getRealizedEquityCurve(),
    ]);
    return NextResponse.json(
      { closedTrades, breakdowns, equityCurve },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[api/analytics]", e);
    return NextResponse.json(
      { closedTrades: [], breakdowns: { byCoin: [], byExitOrigin: [] }, equityCurve: [], error: "DB hiba" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
```

- [ ] **Step 2: Typecheck + build verify**

Run: `npx tsc --noEmit && npx next build`
Expected: 0 tsc hiba; a build a route-listában mutatja a `ƒ /api/analytics`-ot.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/analytics/route.ts
git commit -m "feat(api): /api/analytics route (no-store, realized teljesítmény)"
```

---

## Task 5: `AnalyticsPanel` + Dashboard-bekötés

**Files:**
- Create: `src/components/AnalyticsPanel.tsx`
- Modify: `src/components/Dashboard.tsx`

**Interfaces:**
- Consumes: `/api/analytics` (Task 4) JSON-alakja: `{ closedTrades: ClosedTradeRow[], breakdowns: Breakdowns, equityCurve: EquityPoint[] }`.

- [ ] **Step 1: Write the component** (client-komponens, a meglévő panel-minta szerint — fetch + táblák; a stílus a dashboard-témát követi)

```tsx
// src/components/AnalyticsPanel.tsx
"use client";
import { useEffect, useState } from "react";

interface ClosedTradeRow {
  symbol: string; entryPrice: number; exitPrice: number; qtyClosed: number;
  pnlUsd: number; pnlPct: number; holdHours: number; exitOrigin: string; exitTs: number;
}
interface Breakdown { key: string; trades: number; winRate: number; avgPnlPct: number }
interface Data {
  closedTrades: ClosedTradeRow[];
  breakdowns: { byCoin: Breakdown[]; byExitOrigin: Breakdown[] };
  equityCurve: { ts: number; equityUsd: number }[];
}

export default function AnalyticsPanel() {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    fetch("/api/analytics", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ closedTrades: [], breakdowns: { byCoin: [], byExitOrigin: [] }, equityCurve: [] }));
  }, []);

  if (!data) return <div className="panel">Analitika betöltése…</div>;
  const { closedTrades, breakdowns, equityCurve } = data;
  const last = equityCurve.at(-1)?.equityUsd;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const usd = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div className="panel">
      <h2>Realized teljesítmény</h2>
      <div>Lezárt trade: {closedTrades.length}{last !== undefined ? ` · realized equity: ${usd(last)}` : ""}</div>

      <h3>Bontás coinonként</h3>
      <table>
        <thead><tr><th>Coin</th><th>Trade</th><th>Win</th><th>Átlag P&L</th></tr></thead>
        <tbody>
          {breakdowns.byCoin.map((b) => (
            <tr key={b.key}><td>{b.key}</td><td>{b.trades}</td><td>{pct(b.winRate)}</td><td>{pct(b.avgPnlPct)}</td></tr>
          ))}
        </tbody>
      </table>

      <h3>Bontás kilépés-ok szerint</h3>
      <table>
        <thead><tr><th>Ok</th><th>Trade</th><th>Win</th><th>Átlag P&L</th></tr></thead>
        <tbody>
          {breakdowns.byExitOrigin.map((b) => (
            <tr key={b.key}><td>{b.key}</td><td>{b.trades}</td><td>{pct(b.winRate)}</td><td>{pct(b.avgPnlPct)}</td></tr>
          ))}
        </tbody>
      </table>

      <h3>Utolsó lezárt trade-ek</h3>
      <table>
        <thead><tr><th>Coin</th><th>P&L</th><th>P&L%</th><th>Hold (h)</th><th>Kilépés</th></tr></thead>
        <tbody>
          {closedTrades.slice(-10).reverse().map((t, i) => (
            <tr key={i}><td>{t.symbol}</td><td>{usd(t.pnlUsd)}</td><td>{pct(t.pnlPct)}</td><td>{t.holdHours.toFixed(1)}</td><td>{t.exitOrigin}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Wire into the dashboard**

`src/components/Dashboard.tsx` — a meglévő panel-importok mellé:

```tsx
import AnalyticsPanel from "@/components/AnalyticsPanel";
```

És a JSX-ben, a többi panel közé (pl. a `TradeBlotter`/`BacktestPanel` után), a meglévő elrendezés mintáját követve:

```tsx
<AnalyticsPanel />
```

*(A pontos hely a `Dashboard.tsx` meglévő grid/stack-struktúrájához igazodik — olvasd el a fájlt, és tedd a logikailag passzoló szekcióba, a `BacktestPanel` mellé.)*

- [ ] **Step 3: Build + browser verify**

Run: `npx next build`
Expected: 0 hiba.
Majd `pnpm dev` → `http://localhost:3000`: az „Realized teljesítmény" panel megjelenik; éles DB-vel a lezárt trade-eket/bontásokat mutatja (jelenleg kevés a lezárt trade — lehet üres/rövid, ami helyes).

- [ ] **Step 4: Commit**

```bash
git add src/components/AnalyticsPanel.tsx src/components/Dashboard.tsx
git commit -m "feat(ui): AnalyticsPanel — realized teljesítmény a dashboardon"
```

---

## Task 6: Teljes zöld kapu + lezárás

**Files:** nincs új kód — verifikáció.

- [ ] **Step 1: Teljes kapu**

Run: `pnpm vitest run && pnpm exec tsc --noEmit && pnpm build`
Expected: minden zöld (171 meglévő + 8 új teszt; tsc 0; build OK).

- [ ] **Step 2: Commit (ha maradt nyitott apróság) + a finishing-a-development-branch skill**

A teljes munka után: `superpowers:finishing-a-development-branch` (tesztek verifikálása → merge/PR/keep opciók).

---

## Self-Review (terv ↔ spec)

- **Spec-lefedettség:** liveness dead-man's-switch → Task 1 (helper + wiring + setup-doc); realized ledger/bontás/equity → Task 2 (magok) + Task 3 (DB) + Task 4 (route) + Task 5 (UI); a F&G-bucket szándékosan KIHAGYVA (spec §3.2). ✔
- **Placeholder-szkennelés:** nincs TBD/TODO; minden lépés valódi kódot/parancsot tartalmaz (a Task 5 Step 2 a `Dashboard.tsx` konkrét beillesztési helyét a fájl olvasására bízza, mert a meglévő elrendezés a forrás — ez nem placeholder, hanem a meglévő minta követése). ✔
- **Típus-konzisztencia:** `ClosedTradeRow`/`Breakdowns`/`EquityPoint` egységes Task 2–5-ben; `pingHeartbeat(ok)` Task 1; `getClosedTrades/Breakdowns/RealizedEquityCurve` Task 3 = a route (Task 4) hívása. A drizzle-mezők (`amountUsd`, `feeUsd`, `closedAt`, `executedAt`, `origin`, `initialCapitalUsd`) = a séma (`src/db/schema.ts`). ✔

## Execution Handoff — lásd a fő üzenetet.

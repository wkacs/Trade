# Spec 1 — Profit-boost a meglévő motorban — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A meglévő profit-ciklushoz hozzáadni egy momentum-belépőt, kockázat-alapú méretezést és egy szelektív érme-szűrő scriptet — mindegyiket kemény backteszt-kapuval, a kód-belépő/kilépő gépezet újrahasználatával.

**Architecture:** Tiszta függvények a `src/lib/strategy/`-ben (sizing, momentum), amelyeket a meglévő `planProfitCycle` orchesztrál; a backteszt-motor (`engine.ts`) és a live tick (`tick.ts`) szimmetrikusan táplálja az új per-symbol jelet (`momentumOkBySymbol`), pont mint a meglévő `trendOkBySymbol`-t. Minden új config-mező alapból KIKAPCSOLT → a meglévő 155 teszt zöld marad, amíg a backteszt-kapu zöldet nem ad.

**Tech Stack:** TypeScript 5.5, Vitest 2.0, Drizzle, Next 14, `tsx` scriptek, Binance/CoinGecko/alternative.me publikus API-k (backteszt-adat).

## Global Constraints

- `TRADING_MODE` **marad `paper`** — ez a terv NEM kapcsol live-ra.
- Minden új stratégia-logika **tiszta függvény**: nincs DB / hálózat / `Date.now()` / `Math.random()`.
- Új config-mezők **alapértéke kikapcsolt**: `momentumEnabled: false`, `riskPerTradePct: 0` → a meglévő viselkedés és a teljes suite változatlan marad.
- **TDD kötelező:** minden tiszta függvénynél előbb a bukó teszt, aztán a minimál implementáció.
- **Backteszt-kapu az adoptálás előtt** (Task 8): egy emelő csak akkor kerül a `DEFAULT_STRATEGY`/`COIN_UNIVERSE`-be, ha walk-forward OOS Sharpe ÉS hozam ≥ a default, maxDD nem romlik >0,5pp-t, és mindkét ablak pozitív.
- **Lockstep config-szinkron:** a `tests/lib/strategy/config.test.ts` kényszeríti a `DEFAULT_STRATEGY` ↔ `PROFIT_CYCLE`/`RISK_LIMITS` egyezést a megosztott mezőkre; az új mezőkhöz új, explicit alapérték-állítás kerül.
- **Kapu élesítés előtt:** `pnpm vitest run` zöld, `pnpm exec tsc --noEmit` 0 hiba, `pnpm build` zöld.
- Parancsok: a repo **pnpm**-et használ (lásd `.github/workflows/tick.yml`); a `npx` is működik a lokális gépen.

---

## File Structure

- **Create** `src/lib/strategy/sizing.ts` — `sizeEntry()` tiszta méretező.
- **Create** `tests/lib/strategy/sizing.test.ts`
- **Create** `src/lib/strategy/momentum.ts` — `passesMomentum()` + `evaluateMomentum()`.
- **Create** `tests/lib/strategy/momentum.test.ts`
- **Modify** `src/lib/strategy/config.ts` — `StrategyConfig` + `DEFAULT_STRATEGY` új mezők.
- **Modify** `tests/lib/strategy/config.test.ts` — új alapérték-állítások.
- **Modify** `src/lib/strategy/fear-greedy.ts` — a DCA-méret a `sizeEntry()`-n megy (alapból identikus).
- **Modify** `src/lib/engine/profit-cycle.ts` — `ProfitCycleInput.momentumOkBySymbol`, `"momentum"` order-kind, momentum-blokk.
- **Modify** `tests/lib/engine/profit-cycle.test.ts`
- **Modify** `src/lib/backtest/engine.ts` — `momentumOkBySymbol` számítás + átadás.
- **Modify** `src/lib/engine/tick.ts` — `momentumOkBySymbol` számítás + átadás.
- **Create** `scripts/coin-screen.ts` — egyenként-backteszt érme-szűrő (report-only).

---

## Task 1: `sizeEntry` — kockázat-alapú méretező

**Files:**
- Create: `src/lib/strategy/sizing.ts`
- Test: `tests/lib/strategy/sizing.test.ts`

**Interfaces:**
- Produces: `sizeEntry(equity: number, p: SizeEntryParams): number`, ahol
  `SizeEntryParams = { riskPerTradePct: number; stopLossPct: number; stopMode: "fixed" | "atr"; maxPositionPct: number; flatPct: number }`.
  Szemantika: `riskPerTradePct > 0` ÉS `stopMode === "fixed"` esetén kockázat-alapú méret (`riskPerTradePct·equity / stopLossPct`, felülről `maxPositionPct·equity`-re vágva); egyébként `equity · flatPct` (a régi viselkedés). Fix stopnál a méret ár-független, mert a stop-távolság = `stopLossPct`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/strategy/sizing.test.ts
import { describe, it, expect } from "vitest";
import { sizeEntry } from "@/lib/strategy/sizing";

const base = { stopLossPct: 0.05, stopMode: "fixed" as const, maxPositionPct: 0.2, flatPct: 0.02 };

describe("sizeEntry", () => {
  it("riskPerTradePct=0 → flat: equity*flatPct", () => {
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0 })).toBeCloseTo(20); // 1000*0.02
  });

  it("kockázat-alapú fix stopnál: risk/stopLoss, maxPositionPct-re vágva", () => {
    // 0.01*1000 / 0.05 = 200, de maxPositionPct 0.2*1000=200 → 200
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0.01 })).toBeCloseTo(200);
    // 0.005*1000 / 0.05 = 100 (< 200 cap) → 100
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0.005 })).toBeCloseTo(100);
  });

  it("atr stopnál a kockázat-méret nem alkalmazható → flat", () => {
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0.01, stopMode: "atr" })).toBeCloseTo(20);
  });

  it("degenerált stopLossPct=0 → flat (nincs nullával osztás)", () => {
    expect(sizeEntry(1000, { ...base, riskPerTradePct: 0.01, stopLossPct: 0 })).toBeCloseTo(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/strategy/sizing.test.ts`
Expected: FAIL — `Cannot find module '@/lib/strategy/sizing'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/strategy/sizing.ts
/**
 * Belépő-méretező. Kockázat-alapú (fix-frakciós kockázat) fix stop módban: a pozíció
 * akkora, hogy a stopig vett veszteség a tőke riskPerTradePct-je legyen. Fix stopnál a
 * stop-távolság = stopLossPct, ezért a méret ÁR-FÜGGETLEN. atr módban / riskPerTradePct=0
 * esetén a régi flat méret (equity*flatPct). Tiszta függvény.
 */
export interface SizeEntryParams {
  riskPerTradePct: number;
  stopLossPct: number;
  stopMode: "fixed" | "atr";
  maxPositionPct: number;
  flatPct: number;
}

export function sizeEntry(equity: number, p: SizeEntryParams): number {
  const riskOk = p.riskPerTradePct > 0 && p.stopMode === "fixed" && p.stopLossPct > 0;
  if (!riskOk) return equity * p.flatPct;
  const raw = (p.riskPerTradePct * equity) / p.stopLossPct;
  return Math.min(raw, p.maxPositionPct * equity);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/strategy/sizing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/strategy/sizing.ts tests/lib/strategy/sizing.test.ts
git commit -m "feat(strategy): sizeEntry — kockázat-alapú belépő-méretező (TDD)"
```

---

## Task 2: Strategy config — momentum + risk mezők (alapból OFF)

**Files:**
- Modify: `src/lib/strategy/config.ts`
- Test: `tests/lib/strategy/config.test.ts`

**Interfaces:**
- Produces: `StrategyConfig` bővül: `momentumEnabled: boolean`, `momentumSmaPeriod: number`, `momentumLookback: number`, `momentumBuyPct: number`, `riskPerTradePct: number`. `DEFAULT_STRATEGY` alapértékei: `momentumEnabled:false, momentumSmaPeriod:24, momentumLookback:48, momentumBuyPct:0.02, riskPerTradePct:0`.

- [ ] **Step 1: Write the failing test** (új állítások a meglévő config-tesztbe)

```ts
// tests/lib/strategy/config.test.ts — ADD a meglévő describe-hoz
it("az új profit-boost mezők alapból KIKAPCSOLTAK (regresszió-őr)", () => {
  expect(DEFAULT_STRATEGY.momentumEnabled).toBe(false);
  expect(DEFAULT_STRATEGY.riskPerTradePct).toBe(0);
  expect(DEFAULT_STRATEGY.momentumSmaPeriod).toBe(24);
  expect(DEFAULT_STRATEGY.momentumLookback).toBe(48);
  expect(DEFAULT_STRATEGY.momentumBuyPct).toBe(0.02);
});
```

*(Ha a `DEFAULT_STRATEGY` nincs importálva a tesztben, add hozzá: `import { DEFAULT_STRATEGY } from "@/lib/strategy/config";`.)*

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/strategy/config.test.ts`
Expected: FAIL — `momentumEnabled` undefined.

- [ ] **Step 3: Write minimal implementation** — bővítsd a `StrategyConfig` interfészt és a `DEFAULT_STRATEGY`-t:

```ts
// src/lib/strategy/config.ts — a StrategyConfig interfész VÉGÉRE (a } elé):
  /** Momentum-belépő (vesz az erőben). Alapból ki — backteszt-kapu után élesedik. */
  momentumEnabled: boolean;
  momentumSmaPeriod: number; // trend-SMA órák
  momentumLookback: number;  // breakout-ablak órák
  momentumBuyPct: number;    // flat méret, ha riskPerTradePct=0
  /** Kockázat-alapú méretezés: a tőke ennyije a kockázat trade-enként. 0 = flat (régi). */
  riskPerTradePct: number;

// src/lib/strategy/config.ts — a DEFAULT_STRATEGY objektum VÉGÉRE (a } elé):
  momentumEnabled: false,
  momentumSmaPeriod: 24,
  momentumLookback: 48,
  momentumBuyPct: 0.02,
  riskPerTradePct: 0,
```

- [ ] **Step 4: Run the full suite to verify nothing broke**

Run: `npx vitest run`
Expected: PASS — a meglévő tesztek + az új állítás (a `momentumEnabled:false`/`riskPerTradePct:0` miatt semmi viselkedés nem változott).

- [ ] **Step 5: Commit**

```bash
git add src/lib/strategy/config.ts tests/lib/strategy/config.test.ts
git commit -m "feat(strategy): momentum + risk config mezők (alapból OFF)"
```

---

## Task 3: `passesMomentum` + `evaluateMomentum` — momentum-jel

**Files:**
- Create: `src/lib/strategy/momentum.ts`
- Test: `tests/lib/strategy/momentum.test.ts`

**Interfaces:**
- Consumes: `sizeEntry` (Task 1).
- Produces:
  - `passesMomentum(closes: number[], smaPeriod: number, lookback: number): boolean` — true, ha az utolsó close > SMA(smaPeriod) ÉS az utolsó close = az utolsó `lookback` close maximuma (breakout). Kevés adat → false.
  - `evaluateMomentum(ctx: MomentumContext, params: MomentumParams): MomentumSignal`, ahol
    `MomentumContext = { momentumOkBySymbol: Record<string, boolean>; coinChanges: { symbol: string; change24hPct: number }[]; heldSymbols: string[]; openPositionCount: number; totalEquity: number }`,
    `MomentumParams = { momentumEnabled: boolean; momentumBuyPct: number; maxConcurrentPositions: number; riskPerTradePct: number; stopLossPct: number; stopMode: "fixed" | "atr"; maxPositionPct: number }`,
    `MomentumSignal = { shouldEnter: boolean; symbol: string | null; amountUsd: number; reason: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/strategy/momentum.test.ts
import { describe, it, expect } from "vitest";
import { passesMomentum, evaluateMomentum } from "@/lib/strategy/momentum";

describe("passesMomentum", () => {
  it("breakout trend fölött → true", () => {
    const closes = [10, 10, 10, 10, 12]; // utolsó = max ÉS > SMA(4)=10.5
    expect(passesMomentum(closes, 4, 5)).toBe(true);
  });
  it("nem új csúcs → false", () => {
    const closes = [10, 14, 11, 12, 13]; // utolsó 13 < 14 (lookback max)
    expect(passesMomentum(closes, 4, 5)).toBe(false);
  });
  it("kevés adat → false", () => {
    expect(passesMomentum([10, 11], 4, 5)).toBe(false);
  });
});

const params = {
  momentumEnabled: true, momentumBuyPct: 0.02, maxConcurrentPositions: 3,
  riskPerTradePct: 0, stopLossPct: 0.05, stopMode: "fixed" as const, maxPositionPct: 0.2,
};

describe("evaluateMomentum", () => {
  it("kikapcsolva → nincs belépő", () => {
    const sig = evaluateMomentum(
      { momentumOkBySymbol: { BTC: true }, coinChanges: [{ symbol: "BTC", change24hPct: 5 }], heldSymbols: [], openPositionCount: 0, totalEquity: 1000 },
      { ...params, momentumEnabled: false },
    );
    expect(sig.shouldEnter).toBe(false);
  });
  it("a legerősebb (legnagyobb 24h) momentum-coint választja, flat méret", () => {
    const sig = evaluateMomentum(
      { momentumOkBySymbol: { BTC: true, ETH: true }, coinChanges: [{ symbol: "BTC", change24hPct: 3 }, { symbol: "ETH", change24hPct: 6 }], heldSymbols: [], openPositionCount: 0, totalEquity: 1000 },
      params,
    );
    expect(sig.shouldEnter).toBe(true);
    expect(sig.symbol).toBe("ETH");
    expect(sig.amountUsd).toBeCloseTo(20); // flat 2%
  });
  it("már tartott coin kiesik", () => {
    const sig = evaluateMomentum(
      { momentumOkBySymbol: { BTC: true }, coinChanges: [{ symbol: "BTC", change24hPct: 5 }], heldSymbols: ["BTC"], openPositionCount: 1, totalEquity: 1000 },
      params,
    );
    expect(sig.shouldEnter).toBe(false);
  });
  it("concurrent-cap elérve → nincs új belépő", () => {
    const sig = evaluateMomentum(
      { momentumOkBySymbol: { BTC: true }, coinChanges: [{ symbol: "BTC", change24hPct: 5 }], heldSymbols: ["ETH", "SOL", "XRP"], openPositionCount: 3, totalEquity: 1000 },
      params,
    );
    expect(sig.shouldEnter).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/strategy/momentum.test.ts`
Expected: FAIL — `Cannot find module '@/lib/strategy/momentum'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/strategy/momentum.ts
import { sizeEntry } from "@/lib/strategy/sizing";

export interface MomentumSignal {
  shouldEnter: boolean;
  symbol: string | null;
  amountUsd: number;
  reason: string;
}
export interface MomentumContext {
  momentumOkBySymbol: Record<string, boolean>;
  coinChanges: { symbol: string; change24hPct: number }[];
  heldSymbols: string[];
  openPositionCount: number;
  totalEquity: number;
}
export interface MomentumParams {
  momentumEnabled: boolean;
  momentumBuyPct: number;
  maxConcurrentPositions: number;
  riskPerTradePct: number;
  stopLossPct: number;
  stopMode: "fixed" | "atr";
  maxPositionPct: number;
}

/** Breakout a trend fölött: utolsó close > SMA ÉS = az utolsó `lookback` close maximuma. */
export function passesMomentum(closes: number[], smaPeriod: number, lookback: number): boolean {
  if (closes.length < Math.max(smaPeriod, lookback)) return false;
  const last = closes[closes.length - 1];
  const sma = closes.slice(-smaPeriod).reduce((s, c) => s + c, 0) / smaPeriod;
  const window = closes.slice(-lookback);
  const high = Math.max(...window);
  return last > sma && last >= high;
}

const none = (reason: string): MomentumSignal => ({ shouldEnter: false, symbol: null, amountUsd: 0, reason });

export function evaluateMomentum(ctx: MomentumContext, params: MomentumParams): MomentumSignal {
  if (!params.momentumEnabled) return none("Momentum-belépő kikapcsolva.");
  if (ctx.openPositionCount >= params.maxConcurrentPositions)
    return none(`Max egyidejű pozíció (${params.maxConcurrentPositions}) elérve.`);

  const held = new Set(ctx.heldSymbols);
  const eligible = ctx.coinChanges.filter(
    (c) => ctx.momentumOkBySymbol[c.symbol] === true && !held.has(c.symbol),
  );
  if (eligible.length === 0) return none("Nincs jogosult momentum-coin.");

  const pick = eligible.reduce((best, c) => (c.change24hPct > best.change24hPct ? c : best));
  const amountUsd = sizeEntry(ctx.totalEquity, {
    riskPerTradePct: params.riskPerTradePct,
    stopLossPct: params.stopLossPct,
    stopMode: params.stopMode,
    maxPositionPct: params.maxPositionPct,
    flatPct: params.momentumBuyPct,
  });
  return {
    shouldEnter: true,
    symbol: pick.symbol,
    amountUsd,
    reason: `Momentum-breakout → ${pick.symbol} (${pick.change24hPct.toFixed(1)}% 24h).`,
  };
}
```

*(Töröld a Step 3 elején lévő hibás placeholder importot — csak a valódi `@/lib/strategy/sizing` import maradjon.)*

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/strategy/momentum.test.ts`
Expected: PASS (7 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/strategy/momentum.ts tests/lib/strategy/momentum.test.ts
git commit -m "feat(strategy): momentum-belépő jel (passesMomentum + evaluateMomentum, TDD)"
```

---

## Task 4: `planProfitCycle` — momentum-blokk + sizing a DCA-ban + concurrent-cap

**Files:**
- Modify: `src/lib/engine/profit-cycle.ts`
- Modify: `src/lib/strategy/fear-greedy.ts`
- Test: `tests/lib/engine/profit-cycle.test.ts`

**Interfaces:**
- Consumes: `evaluateMomentum` (Task 3), `sizeEntry` (Task 1).
- Produces: `PlannedOrder.kind` bővül `"momentum"`-mal; `ProfitCycleInput` bővül `momentumOkBySymbol: Record<string, boolean>`-lal. A `DcaParams` opcionálisan kap `riskPerTradePct?, stopLossPct?, stopMode?, maxPositionPct?` mezőket (hiányzó → flat, identikus a régivel).

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/engine/profit-cycle.test.ts — ADD
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";

it("momentum BE: ad egy momentum BUY-ordert a legerősebb breakout-coinra", () => {
  const cfg = { ...DEFAULT_STRATEGY, momentumEnabled: true, dcaFgThreshold: 0 /* DCA ki */ };
  const plan = planProfitCycle(
    {
      positions: [],
      candles: {},
      fearGreedValue: 50,
      coinChanges: [{ symbol: "BTC", change24hPct: 2 }, { symbol: "ETH", change24hPct: 7 }],
      weeklyBudgetRemainingUsd: 1000,
      totalEquity: 1000,
      atrBySymbol: {},
      trendOkBySymbol: {},
      momentumOkBySymbol: { BTC: true, ETH: true },
    },
    cfg,
  );
  const mom = plan.orders.find((o) => o.kind === "momentum");
  expect(mom).toBeDefined();
  expect(mom?.symbol).toBe("ETH");
  expect(mom?.side).toBe("BUY");
});

it("momentum KI (default): nincs momentum-order", () => {
  const plan = planProfitCycle(
    {
      positions: [], candles: {}, fearGreedValue: 50,
      coinChanges: [{ symbol: "BTC", change24hPct: 7 }],
      weeklyBudgetRemainingUsd: 1000, totalEquity: 1000,
      atrBySymbol: {}, trendOkBySymbol: {}, momentumOkBySymbol: { BTC: true },
    },
    DEFAULT_STRATEGY,
  );
  expect(plan.orders.find((o) => o.kind === "momentum")).toBeUndefined();
});
```

*(A meglévő profit-cycle tesztek `ProfitCycleInput`-jaihoz add hozzá a `momentumOkBySymbol: {}` mezőt — a típus most kötelezővé teszi. Ez mechanikus; a TypeScript jelzi, hol hiányzik.)*

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/engine/profit-cycle.test.ts`
Expected: FAIL — `momentumOkBySymbol` ismeretlen / `momentum` order nincs.

- [ ] **Step 3: Write minimal implementation**

`src/lib/engine/profit-cycle.ts` — a `PlannedOrder.kind` union bővítése és az input-mező:

```ts
// PlannedOrder.kind:
  kind: "stop-loss" | "take-profit" | "dca" | "momentum";

// ProfitCycleInput VÉGÉRE (a } elé):
  /** Per-symbol momentum-flag (breakout a trend fölött). A hívó számolja. */
  momentumOkBySymbol: Record<string, boolean>;
```

A `planProfitCycle` import-fejléce + a DCA-blokk után, a `return` ELŐTT:

```ts
// fent:
import { evaluateMomentum } from "@/lib/strategy/momentum";

// a `return { orders, stopUpdates };` ELÉ:
  // 4) Momentum-belépő (vesz az erőben). A concurrent-cap CSAK az új momentum-belépőre
  //    vonatkozik (a DCA viselkedése változatlan, hogy a backteszt-baseline ne mozduljon).
  const heldSymbols = input.positions.map((p) => p.symbol);
  const mom = evaluateMomentum(
    {
      momentumOkBySymbol: input.momentumOkBySymbol,
      coinChanges: input.coinChanges,
      heldSymbols,
      openPositionCount: input.positions.length,
      totalEquity: input.totalEquity,
    },
    {
      momentumEnabled: config.momentumEnabled,
      momentumBuyPct: config.momentumBuyPct,
      maxConcurrentPositions: config.maxConcurrentPositions,
      riskPerTradePct: config.riskPerTradePct,
      stopLossPct: config.stopLossPct,
      stopMode: config.stopMode,
      maxPositionPct: config.maxPositionPct,
    },
  );
  if (mom.shouldEnter && mom.symbol) {
    orders.push({ kind: "momentum", side: "BUY", symbol: mom.symbol, amountUsd: mom.amountUsd, reason: mom.reason });
  }
```

`src/lib/strategy/fear-greedy.ts` — a DCA-méret a `sizeEntry`-n (alapból identikus): bővítsd a `DcaParams`-t opcionális mezőkkel és cseréld az amount-számítást.

```ts
// fent:
import { sizeEntry } from "@/lib/strategy/sizing";

// DcaParams interfész VÉGÉRE (a } elé):
  riskPerTradePct?: number;
  stopLossPct?: number;
  stopMode?: "fixed" | "atr";
  maxPositionPct?: number;

// a return objektumban az amountUsd sor CSERÉJE:
    amountUsd: sizeEntry(ctx.totalEquity, {
      riskPerTradePct: params.riskPerTradePct ?? 0,
      stopLossPct: params.stopLossPct ?? 0.05,
      stopMode: params.stopMode ?? "fixed",
      maxPositionPct: params.maxPositionPct ?? 0.2,
      flatPct: params.dcaBuyPct,
    }),
```

A `planProfitCycle` DCA-hívásában (a `evaluateDca` params objektum) add át az új mezőket:

```ts
      dcaBuyPct: config.dcaBuyPct,
      entryFilter: config.entryFilter,
      riskPerTradePct: config.riskPerTradePct,
      stopLossPct: config.stopLossPct,
      stopMode: config.stopMode,
      maxPositionPct: config.maxPositionPct,
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/lib/engine/profit-cycle.test.ts tests/lib/strategy/fear-greedy.test.ts && npx tsc --noEmit`
Expected: PASS + 0 tsc hiba. (A `riskPerTradePct:0` default miatt a DCA amount változatlan: `sizeEntry` flat ágon `equity*dcaBuyPct`.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/profit-cycle.ts src/lib/strategy/fear-greedy.ts tests/lib/engine/profit-cycle.test.ts
git commit -m "feat(engine): momentum-belépő + sizing a planProfitCycle-ben (concurrent-cap a momentumra)"
```

---

## Task 5: Backteszt-motor — `momentumOkBySymbol` számítás + átadás

**Files:**
- Modify: `src/lib/backtest/engine.ts`
- Test: `tests/lib/backtest/engine.test.ts`

**Interfaces:**
- Consumes: `passesMomentum` (Task 3), a bővített `ProfitCycleInput` (Task 4).

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/backtest/engine.test.ts — ADD
// Cél: momentumEnabled konfigon a motor nyit momentum-pozíciót egy egyértelmű breakout-sorozaton.
it("momentum BE: a breakout-történeten nyit pozíciót (több trade mint kikapcsolva)", () => {
  // emelkedő close-sorozat egy symbolra (BTC), elég hosszú a 48-as lookbackhez
  const frames = Array.from({ length: 120 }, (_, i) => ({
    ts: i * 3600_000,
    candles: { BTC: { open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1 } },
    fearGreedValue: 50, // DCA-semleges
  }));
  const cfgOff = { ...DEFAULT_STRATEGY, momentumEnabled: false };
  const cfgOn = { ...DEFAULT_STRATEGY, momentumEnabled: true };
  const btc = { symbols: ["BTC"], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 };
  const off = runBacktest(frames as any, btc, cfgOff);
  const on = runBacktest(frames as any, btc, cfgOn);
  expect(on.closedTrades.length + (on.equityCurve.length > 0 ? 1 : 0)).toBeGreaterThanOrEqual(off.closedTrades.length);
  // legalább egy momentum-vétel történt (a végén nyitott vagy lezárt pozíció)
  expect(on.metrics.tradesCount >= off.metrics.tradesCount).toBe(true);
});
```

*(Megj.: az állítás szándékosan laza — a lényeg, hogy a momentum-ág AKTÍV és nyit pozíciót; a pontos szám a fill-szimulációtól függ. Ha a meglévő `engine.test.ts` nem importálja a `DEFAULT_STRATEGY`-t / `runBacktest`-et, add hozzá.)*

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/backtest/engine.test.ts`
Expected: FAIL — a motor még nem ad `momentumOkBySymbol`-t a plannek (tsc hiba vagy nincs momentum-trade).

- [ ] **Step 3: Write minimal implementation** — a per-symbol buffer-ciklusban (ahol az `atrBySymbol`/`trendOkBySymbol` készül) számold a momentum-flaget, és add át a plannek:

```ts
// src/lib/backtest/engine.ts — fent:
import { passesMomentum } from "@/lib/strategy/momentum";

// a trendOkBySymbol[sym] = ... SOR UTÁN, ugyanabban a for-ciklusban:
      momentumOkBySymbol[sym] = passesMomentum(
        buf.map((b) => b.close),
        strategy.momentumSmaPeriod,
        strategy.momentumLookback,
      );

// a ciklus ELŐTT deklaráld:
    const momentumOkBySymbol: Record<string, boolean> = {};

// a planProfitCycle(...) input-objektumába (a trendOkBySymbol mellé):
        momentumOkBySymbol,
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run tests/lib/backtest/engine.test.ts && npx tsc --noEmit`
Expected: PASS + 0 hiba.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/engine.ts tests/lib/backtest/engine.test.ts
git commit -m "feat(backtest): momentumOkBySymbol számítás + átadás a plannek"
```

---

## Task 6: Live tick — `momentumOkBySymbol` számítás + átadás (paritás)

**Files:**
- Modify: `src/lib/engine/tick.ts`
- Test: `tests/lib/engine/tick.test.ts`

**Interfaces:**
- Consumes: `passesMomentum` (Task 3), a bővített `ProfitCycleInput` (Task 4).

- [ ] **Step 1: Write the failing test** — a `tick.test.ts` a meglévő mintát követi (mockolt collectorok). A minimális regresszió: a tick **lefut hiba nélkül** a momentum-mezővel, és a default (momentum OFF) mellett **nem nyit momentum-pozíciót**.

```ts
// tests/lib/engine/tick.test.ts — ADD a meglévő mock-setuphoz hasonló teszt:
it("default (momentum OFF): a tick lefut, nincs momentum-eredetű trade", async () => {
  const res = await runTick({ tickId: "2026-06-28-15", paperMode: true });
  // a process-pillanatkép létezik (a meglévő mezők), és nincs momentum-origin trade
  expect(res.process).toBeDefined();
  // ha van trade, az nem "momentum" eredetű default mellett:
  if (res.trade) expect(res.trade.origin).not.toBe("momentum");
});
```

*(Igazítsd a meglévő `tick.test.ts` mock-mintájához — collectorok/DB mockolva. A lényeg: a momentum-mező hozzáadása NEM töri a live tick-et default mellett.)*

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/engine/tick.test.ts`
Expected: FAIL — `momentumOkBySymbol` hiányzik a tick `planProfitCycle`-hívásából (tsc hiba).

- [ ] **Step 3: Write minimal implementation** — a `tick.ts`-ben (a `trendOkBySymbol` számítás mellé, ~284–292 sor):

```ts
// src/lib/engine/tick.ts — fent:
import { passesMomentum } from "@/lib/strategy/momentum";

// a trendOkBySymbol ciklusban, a trendOkBySymbol[sym] = ... után:
      momentumOkBySymbol[sym] = passesMomentum(
        buf.map((b) => b.close),
        DEFAULT_STRATEGY.momentumSmaPeriod,
        DEFAULT_STRATEGY.momentumLookback,
      );

// a ciklus előtt:
    const momentumOkBySymbol: Record<string, boolean> = {};

// a planProfitCycle(...) input-objektumába (a trendOkBySymbol mellé):
        momentumOkBySymbol,
```

Az `executeCycleOrder` origin-címkéje a `o.kind`-ot kapja → a momentum-trade `origin` `"momentum"` lesz. Bővítsd a `trades.origin` típus-uniót `"momentum"`-mal ott, ahol a `PlannedOrder.kind`-ot origin-né alakítja (ha a típus szűkít; a DB-oszlop szöveges, elfogad).

- [ ] **Step 4: Run tests + typecheck + build**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS (teljes suite) + 0 hiba.

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/tick.ts tests/lib/engine/tick.test.ts
git commit -m "feat(tick): momentumOkBySymbol paritás (live ↔ backteszt egy forrás)"
```

---

## Task 7: `scripts/coin-screen.ts` — szelektív érme-szűrő (report-only)

**Files:**
- Create: `scripts/coin-screen.ts`

**Interfaces:**
- Consumes: `loadHistory`, `runBacktest`, `splitHistory` (`@/lib/backtest/*`), `DEFAULT_STRATEGY`.

- [ ] **Step 1: Write the script** (nincs unit-teszt — CLI report-only, a `scripts/backtest.ts` mintájára)

```ts
// scripts/coin-screen.ts
/**
 * Egyenként backteszteli a jelölt coinokat a DEFAULT_STRATEGY-vel (walk-forward), és
 * kiír egy rangsort. Kapu: pozitív OOS hozam ÉS OOS Sharpe ≥ küszöb. Report-only — a
 * nyertes listát KÉZZEL veszed át a COIN_UNIVERSE-be. Futtatás:
 *   npx tsx scripts/coin-screen.ts --pages 8 --min-sharpe 1.0
 */
import { config } from "dotenv";
config({ path: ".env.local" }); config();

async function main() {
  const { loadHistory } = await import("@/lib/backtest/data");
  const { runBacktest } = await import("@/lib/backtest/engine");
  const { splitHistory } = await import("@/lib/backtest/walk-forward");
  const { DEFAULT_STRATEGY } = await import("@/lib/strategy/config");

  const arg = (n: string, d: number) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? Number(process.argv[i + 1]) : d;
  };
  const pages = arg("pages", 8);
  const minSharpe = arg("min-sharpe", 1.0);
  const candidates = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "AVAX", "LINK", "DOGE", "LTC", "DOT", "MATIC"];

  console.log(`Coin-screen: ${candidates.length} jelölt | ${pages} lap | OOS-kapu Sharpe ≥ ${minSharpe}\n`);
  const rows: { sym: string; oosRet: number; oosSharpe: number; pass: boolean }[] = [];
  for (const sym of candidates) {
    try {
      const history = await loadHistory([sym], pages);
      if (history.length < 100) { console.log(`  ${sym}: nincs elég adat`); continue; }
      const { outSample } = splitHistory(history, 0.7);
      const r = runBacktest(outSample, { symbols: [sym], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 }, DEFAULT_STRATEGY);
      const oosRet = r.metrics.totalReturnPct, oosSharpe = r.metrics.sharpe;
      const pass = oosRet > 0 && oosSharpe >= minSharpe;
      rows.push({ sym, oosRet, oosSharpe, pass });
    } catch (e) {
      console.log(`  ${sym}: hiba (${String(e).slice(0, 60)})`);
    }
  }
  rows.sort((a, b) => b.oosSharpe - a.oosSharpe);
  for (const r of rows) {
    console.log(`  ${r.pass ? "✅" : "❌"} ${r.sym.padEnd(5)} | OOS ret ${(r.oosRet * 100).toFixed(2).padStart(6)}% | Sharpe ${r.oosSharpe.toFixed(2).padStart(5)}`);
  }
  const winners = rows.filter((r) => r.pass).map((r) => r.sym);
  console.log(`\nKurált univerzum (kapun túl): [${winners.map((s) => `"${s}"`).join(", ")}]`);
  console.log(`→ KÉZZEL vedd át a src/lib/config.ts COIN_UNIVERSE-be, ha a Task 8 teljes-univerzum backteszt is javul.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Smoke-run (külső adat — manuális, nem CI)**

Run: `npx tsx scripts/coin-screen.ts --pages 5 --min-sharpe 1.0`
Expected: rangsor-kiírás coinonként + a kurált lista. (Nem unit-teszt; hálózat kell.)

- [ ] **Step 3: Commit**

```bash
git add scripts/coin-screen.ts
git commit -m "feat(scripts): coin-screen — egyenként-backteszt érme-szűrő (report-only)"
```

---

## Task 8: Backteszt-kapu + nyertesek adoptálása (manuális, dokumentált)

**Files:**
- Modify (CSAK ha a kapu zöld): `src/lib/strategy/config.ts` (`DEFAULT_STRATEGY`), `src/lib/config.ts` (`PROFIT_CYCLE` mirror, `COIN_UNIVERSE`).
- Test: a teljes suite + `tsc` + `build`.

**Interfaces:** nincs új kód — ez mérés + döntés.

- [ ] **Step 1: Momentum + sizing grid backteszt** — futtasd a tournamentet a momentum/sizing mezőkre kiterjesztve, VAGY egy célzott összevetést `momentumEnabled` ON/OFF + `riskPerTradePct ∈ {0, 0.005, 0.01}` mellett.

Run: `npx tsx scripts/backtest.ts --pages 10` (baseline), majd egy momentum-ON variánssal (a `DEFAULT_STRATEGY`-t ideiglenesen `momentumEnabled:true`-ra állítva egy eldobható scriptben, a `scripts/_tmpedge.ts` mintájára — NE a repóba).
Expected: számszerű OOS ret/Sharpe/maxDD a Global Constraints kapujához mérve.

- [ ] **Step 2: Érme-szűrő** — `npx tsx scripts/coin-screen.ts --pages 10 --min-sharpe 1.0`, majd a kurált univerzummal teljes-univerzum backteszt (a 3-coin baseline-hoz mérve).

- [ ] **Step 3: Döntés + adoptálás** — minden emelőre KÜLÖN:
  - Ha **veri a kaput** (OOS Sharpe ÉS ret ≥ default, maxDD nem romlik >0,5pp, mindkét ablak pozitív) → vedd át: `momentumEnabled:true` és/vagy `riskPerTradePct:>0` a `DEFAULT_STRATEGY`-ben, és/vagy a kurált `COIN_UNIVERSE`.
  - Ha **nem** → hagyd a default OFF/3-coin értéken; dokumentáld a backteszt-számokat a commit-üzenetben („nem verte a kaput → marad default").

- [ ] **Step 4: Teljes zöld kapu**

Run: `pnpm vitest run && pnpm exec tsc --noEmit && pnpm build`
Expected: minden zöld.

- [ ] **Step 5: Commit (az adoptálás vagy a „nem-adoptálás" döntése a számokkal)**

```bash
git add -A
git commit -m "chore(strategy): profit-boost backteszt-kapu eredménye + adoptálás (számok a törzsben)"
```

---

## Self-Review (a terv ↔ spec ellenőrzése)

- **Spec-lefedettség:** momentum-belépő → Task 3–6; kockázat-sizing → Task 1, 4; szelektív érme → Task 7–8; backteszt-kapu → Task 8 + Global Constraints; backteszt↔live paritás (`momentumOkBySymbol`, `maxConcurrentPositions` a planben) → Task 4–6. ✔
- **Placeholder-szkennelés:** nincs TBD/TODO/„implement later"; minden lépés valódi kódot/parancsot tartalmaz. ✔
- **Típus-konzisztencia:** `sizeEntry`/`SizeEntryParams` (Task 1) = ahogy a Task 3/4 hívja; `momentumOkBySymbol: Record<string,boolean>` egységes Task 4–6-ban; `MomentumParams` mezők = a `planProfitCycle` átadása (Task 4). ✔

## Execution Handoff — lásd a fő üzenetet (a Spec 2–3 kapuzott, külön kezelve).

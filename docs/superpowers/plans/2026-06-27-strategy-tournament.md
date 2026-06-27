# Stratégia-tournament (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stratégiát `StrategyConfig`-vezérelté tenni, walk-forward variáns-tournamentet építeni (OOS Sharpe rangsor), két új tunolható levert (ATR-stop, belépő-szűrő) hozzáadni, és a „Heti DCA-keret elfogyott" AI-BUY fagyást megszüntetni.

**Architecture:** Egy `StrategyConfig` objektum vezérli a stratégiát; `DEFAULT_STRATEGY` = a mai konstansok → a live `runTick` viselkedése változatlan (a 130 teszt a guard). A pure helperek (ATR, SMA-filter, walk-forward) elkészülnek, majd a döntés-függvények (evaluatePosition/evaluateDca/applyRisk/planProfitCycle) config-vezéreltté válnak, a backtest átveszi a strategy-t, végül a tournament CLI sweepeli a gridet.

**Tech Stack:** TypeScript, Vitest (TDD), tsx (CLI). Épít a meglévő backtest-motorra (`src/lib/backtest/*`).

## Global Constraints

- `DEFAULT_STRATEGY` **pontosan a mai viselkedés** → minden refaktor után a **130 meglévő teszt zöld** (parity guard).
- A tiszta helperek (`atr`, `entry-filter`, `walk-forward`) **nem hívnak** `Date.now`/`Math.random`/IO-t (determinizmus).
- `pnpm exec tsc --noEmit` 0 hiba; `pnpm build` zöld; magyar kommentek, `@/`-alias importok.
- Report-only tournament: **nincs auto-apply, nincs DB-írás**.
- Minden teszt-fájl a meglévő mintát követi: `tests/lib/...` tükrözi a `src/lib/...` utat.

---

## File Structure

- `src/lib/strategy/config.ts` — **új** — `StrategyConfig` + `DEFAULT_STRATEGY`.
- `src/lib/strategy/atr.ts` — **új, tiszta** — `computeAtr`.
- `src/lib/strategy/entry-filter.ts` — **új, tiszta** — `sma`, `passesTrendFilter`.
- `src/lib/backtest/walk-forward.ts` — **új, tiszta** — `splitHistory`, `rankConfigs`.
- `src/lib/strategy/position-actions.ts` — **refaktor** — `evaluatePosition` TP configból.
- `src/lib/strategy/fear-greedy.ts` — **refaktor** — `evaluateDca` config + trend-szűrő.
- `src/lib/risk/risk-manager.ts` — **refaktor** — heti-keret kapu KI az AI-BUY-ról + config-limitek.
- `src/lib/engine/profit-cycle.ts` — **refaktor** — `planProfitCycle(input, config)` + ATR-stop + trend.
- `src/lib/backtest/engine.ts` — **refaktor** — `runBacktest(history, btConfig, strategy)` + per-frame ATR/SMA.
- `src/lib/engine/tick.ts` — **kis refaktor** — `DEFAULT_STRATEGY` + ATR/SMA az OHLC-ból.
- `scripts/tournament.ts` — **új** — grid + walk-forward + leaderboard.

---

## Task 1: `StrategyConfig` + `DEFAULT_STRATEGY`

**Files:**
- Create: `src/lib/strategy/config.ts`
- Test: `tests/lib/strategy/config.test.ts`

**Interfaces:**
- Produces: `StrategyConfig` (típus), `DEFAULT_STRATEGY` (konstans).

- [ ] **Step 1: Írd meg a típust + konstanst**

`src/lib/strategy/config.ts`:
```ts
/** A stratégia minden tunolható paramétere — a tournament ezt sweepeli. */
export interface StrategyConfig {
  stopMode: "fixed" | "atr";
  stopLossPct: number; // fixed mód: stop = entry*(1-stopLossPct)
  atrMult: number; // atr mód: stop = entry - atrMult*ATR
  atrPeriod: number;
  takeProfitPct: number;
  takeProfitFraction: number; // 0.5 = fél, 1.0 = teljes
  dcaFgThreshold: number;
  dcaBuyPct: number;
  dcaWeeklyBudgetPct: number;
  dcaMax24hDropPct: number;
  entryFilter: "off" | "trend";
  entryFilterSmaPeriod: number; // órák
  maxPositionPct: number;
  maxConcurrentPositions: number;
  dailyLossCircuitBreakerPct: number;
}

/** A MAI viselkedés (parity) — a live ezt használja, a tournament ettől tér el. */
export const DEFAULT_STRATEGY: StrategyConfig = {
  stopMode: "fixed",
  stopLossPct: 0.05,
  atrMult: 2,
  atrPeriod: 14,
  takeProfitPct: 0.15,
  takeProfitFraction: 0.5,
  dcaFgThreshold: 25,
  dcaBuyPct: 0.02,
  dcaWeeklyBudgetPct: 0.05,
  dcaMax24hDropPct: 0.08,
  entryFilter: "off",
  entryFilterSmaPeriod: 24,
  maxPositionPct: 0.2,
  maxConcurrentPositions: 3,
  dailyLossCircuitBreakerPct: 0.03,
};
```

- [ ] **Step 2: Írd meg a bukó tesztet (parity: DEFAULT == mai konstansok)**

`tests/lib/strategy/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import { RISK_LIMITS, PROFIT_CYCLE } from "@/lib/config";

describe("DEFAULT_STRATEGY", () => {
  it("a mai RISK_LIMITS-szel egyezik", () => {
    expect(DEFAULT_STRATEGY.stopLossPct).toBe(RISK_LIMITS.stopLossPct);
    expect(DEFAULT_STRATEGY.maxPositionPct).toBe(RISK_LIMITS.maxPositionPct);
    expect(DEFAULT_STRATEGY.maxConcurrentPositions).toBe(RISK_LIMITS.maxConcurrentPositions);
    expect(DEFAULT_STRATEGY.dailyLossCircuitBreakerPct).toBe(RISK_LIMITS.dailyLossCircuitBreakerPct);
  });
  it("a mai PROFIT_CYCLE-lel egyezik", () => {
    expect(DEFAULT_STRATEGY.takeProfitPct).toBe(PROFIT_CYCLE.takeProfitPct);
    expect(DEFAULT_STRATEGY.dcaFgThreshold).toBe(PROFIT_CYCLE.dcaFgThreshold);
    expect(DEFAULT_STRATEGY.dcaWeeklyBudgetPct).toBe(PROFIT_CYCLE.dcaWeeklyBudgetPct);
    expect(DEFAULT_STRATEGY.dcaBuyPct).toBe(PROFIT_CYCLE.dcaBuyPct);
    expect(DEFAULT_STRATEGY.dcaMax24hDropPct).toBe(PROFIT_CYCLE.dcaMax24hDropPct);
  });
  it("alapból a mai módok: fixed stop, szűrő off, fél take-profit", () => {
    expect(DEFAULT_STRATEGY.stopMode).toBe("fixed");
    expect(DEFAULT_STRATEGY.entryFilter).toBe("off");
    expect(DEFAULT_STRATEGY.takeProfitFraction).toBe(0.5);
  });
});
```

- [ ] **Step 3: Futtasd — bukjon, majd passzoljon**

Run: `pnpm test tests/lib/strategy/config.test.ts`
Expected: előbb FAIL (nincs config.ts) → a Step 1 után PASS (3 teszt).

- [ ] **Step 4: Commit**

```bash
git add src/lib/strategy/config.ts tests/lib/strategy/config.test.ts
git commit -m "feat(strategy): StrategyConfig + DEFAULT_STRATEGY (parity = mai konstansok)"
```

---

## Task 2: ATR (Average True Range)

**Files:**
- Create: `src/lib/strategy/atr.ts`
- Test: `tests/lib/strategy/atr.test.ts`

**Interfaces:**
- Produces: `computeAtr(candles: { high: number; low: number; close: number }[], period: number): number`.

- [ ] **Step 1: Írd meg a bukó tesztet**

`tests/lib/strategy/atr.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeAtr } from "@/lib/strategy/atr";

const c = (high: number, low: number, close: number) => ({ high, low, close });

describe("computeAtr", () => {
  it("TR = max(h-l, |h-prevClose|, |l-prevClose|), majd átlag", () => {
    // 3 gyertya: TR1 (i=1): h12 l9 pc10 → max(3,2,1)=3; TR2 (i=2): h14 l11 pc11 → max(3,3,0)=3
    const atr = computeAtr([c(11, 10, 10), c(12, 9, 11), c(14, 11, 13)], 14);
    expect(atr).toBeCloseTo(3, 6);
  });
  it("period ablakot vesz (csak az utolsó N TR)", () => {
    const atr = computeAtr([c(10, 9, 10), c(11, 10, 11), c(20, 10, 15)], 1);
    // period 1 → csak az utolsó TR: h20 l10 pc11 → max(10,9,1)=10
    expect(atr).toBeCloseTo(10, 6);
  });
  it("<2 gyertya → 0 (nem dob)", () => {
    expect(computeAtr([c(10, 9, 10)], 14)).toBe(0);
    expect(computeAtr([], 14)).toBe(0);
  });
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/strategy/atr.test.ts`
Expected: FAIL — `computeAtr` nincs.

- [ ] **Step 3: Implementáld**

`src/lib/strategy/atr.ts`:
```ts
/** Average True Range — volatilitás-mérték a gyertyákból. Tiszta. */
export function computeAtr(
  candles: { high: number; low: number; close: number }[],
  period: number,
): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const window = trs.slice(-period);
  return window.reduce((s, t) => s + t, 0) / (window.length || 1);
}
```

- [ ] **Step 4: Futtasd — passzoljon**

Run: `pnpm test tests/lib/strategy/atr.test.ts`
Expected: PASS (3 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/strategy/atr.ts tests/lib/strategy/atr.test.ts
git commit -m "feat(strategy): computeAtr (ATR a gyertyákból)"
```

---

## Task 3: Belépő-szűrő (SMA-trend)

**Files:**
- Create: `src/lib/strategy/entry-filter.ts`
- Test: `tests/lib/strategy/entry-filter.test.ts`

**Interfaces:**
- Produces: `sma(values: number[], period: number): number`, `passesTrendFilter(closes: number[], period: number): boolean`.

- [ ] **Step 1: Írd meg a bukó tesztet**

`tests/lib/strategy/entry-filter.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { sma, passesTrendFilter } from "@/lib/strategy/entry-filter";

describe("entry-filter", () => {
  it("sma az utolsó N érték átlaga", () => {
    expect(sma([10, 20, 30, 40], 2)).toBeCloseTo(35, 6); // (30+40)/2
  });
  it("átmegy, ha az utolsó close ≥ SMA (nem lefelé trend)", () => {
    expect(passesTrendFilter([10, 11, 12, 13], 4)).toBe(true); // 13 ≥ 11.5
  });
  it("kiesik, ha az utolsó close < SMA (lefelé trend)", () => {
    expect(passesTrendFilter([20, 18, 14, 10], 4)).toBe(false); // 10 < 15.5
  });
  it("üres input → átmegy (nem blokkol vakon)", () => {
    expect(passesTrendFilter([], 4)).toBe(true);
  });
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/strategy/entry-filter.test.ts`
Expected: FAIL — nincs `sma`/`passesTrendFilter`.

- [ ] **Step 3: Implementáld**

`src/lib/strategy/entry-filter.ts`:
```ts
/** Egyszerű mozgóátlag az utolsó `period` értékből. Tiszta. */
export function sma(values: number[], period: number): number {
  const w = values.slice(-period);
  return w.reduce((s, v) => s + v, 0) / (w.length || 1);
}

/** Trend-szűrő: igaz, ha az utolsó close ≥ SMA(period) (nem szabadeséses lefelé trend). */
export function passesTrendFilter(closes: number[], period: number): boolean {
  if (closes.length === 0) return true;
  const last = closes[closes.length - 1];
  return last >= sma(closes, period);
}
```

- [ ] **Step 4: Futtasd — passzoljon**

Run: `pnpm test tests/lib/strategy/entry-filter.test.ts`
Expected: PASS (4 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/strategy/entry-filter.ts tests/lib/strategy/entry-filter.test.ts
git commit -m "feat(strategy): belépő-szűrő (SMA-trend)"
```

---

## Task 4: Walk-forward (split + rangsor)

**Files:**
- Create: `src/lib/backtest/walk-forward.ts`
- Test: `tests/lib/backtest/walk-forward.test.ts`

**Interfaces:**
- Consumes: `HistoryFrame`, `BacktestResult` (`src/lib/backtest/types.ts`).
- Produces: `splitHistory(frames, ratio): { inSample, outSample }`, `rankConfigs<C>(items: { config: C; is: BacktestResult; oos: BacktestResult }[], minTrades: number): {...}[]`.

- [ ] **Step 1: Írd meg a bukó tesztet**

`tests/lib/backtest/walk-forward.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { splitHistory, rankConfigs } from "@/lib/backtest/walk-forward";
import type { HistoryFrame, BacktestResult } from "@/lib/backtest/types";

const frame = (ts: number): HistoryFrame => ({ ts, candles: {}, fearGreedValue: null });
const res = (sharpe: number, trades: number, ret = 0): BacktestResult =>
  ({
    metrics: { totalReturnPct: ret, sharpe, maxDrawdownPct: 0, hitRate: 0, tradesCount: trades, avgWinPct: 0, avgLossPct: 0, profitFactor: 0, exposurePct: 0 },
    equityCurve: [], closedTrades: [], config: { symbols: [], initialCapitalUsd: 0, feePct: 0, slippageBps: 0 }, from: 0, to: 0,
  });

describe("walk-forward", () => {
  it("splitHistory 70/30 arányban, idő szerint", () => {
    const frames = Array.from({ length: 10 }, (_, i) => frame(i));
    const { inSample, outSample } = splitHistory(frames, 0.7);
    expect(inSample).toHaveLength(7);
    expect(outSample).toHaveLength(3);
    expect(outSample[0].ts).toBe(7);
  });

  it("rankConfigs az OOS Sharpe szerint, min-trade szűrővel", () => {
    const items = [
      { config: "A", is: res(5, 50), oos: res(0.2, 30) },
      { config: "B", is: res(1, 50), oos: res(0.9, 30) }, // jobb OOS
      { config: "C", is: res(9, 50), oos: res(2.0, 5) }, // kevés OOS trade → kiesik
    ];
    const ranked = rankConfigs(items, 15);
    expect(ranked.map((r) => r.config)).toEqual(["B", "A"]);
  });
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/backtest/walk-forward.test.ts`
Expected: FAIL — nincs `splitHistory`/`rankConfigs`.

- [ ] **Step 3: Implementáld**

`src/lib/backtest/walk-forward.ts`:
```ts
import type { HistoryFrame, BacktestResult } from "./types";

/** Idő szerinti split: első `ratio` rész = in-sample, a maradék = out-of-sample. */
export function splitHistory(
  frames: HistoryFrame[],
  ratio = 0.7,
): { inSample: HistoryFrame[]; outSample: HistoryFrame[] } {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(sorted.length * ratio);
  return { inSample: sorted.slice(0, cut), outSample: sorted.slice(cut) };
}

export interface RankedConfig<C> {
  config: C;
  is: BacktestResult;
  oos: BacktestResult;
}

/** Rangsor OOS Sharpe szerint (csökkenő); min-trade kapu az OOS-on; holtverseny → OOS return. */
export function rankConfigs<C>(items: RankedConfig<C>[], minTrades: number): RankedConfig<C>[] {
  return items
    .filter((x) => x.oos.metrics.tradesCount >= minTrades)
    .sort(
      (a, b) =>
        b.oos.metrics.sharpe - a.oos.metrics.sharpe ||
        b.oos.metrics.totalReturnPct - a.oos.metrics.totalReturnPct,
    );
}
```

- [ ] **Step 4: Futtasd — passzoljon**

Run: `pnpm test tests/lib/backtest/walk-forward.test.ts`
Expected: PASS (2 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/walk-forward.ts tests/lib/backtest/walk-forward.test.ts
git commit -m "feat(backtest): walk-forward split + OOS Sharpe rangsor"
```

---

## Task 5: `evaluatePosition` — take-profit configból

**Files:**
- Modify: `src/lib/strategy/position-actions.ts`
- Modify: `tests/lib/strategy/position-actions.test.ts`
- Modify a hívók: `src/lib/engine/profit-cycle.ts` (Task 8-ban véglegesül; itt a hívás 2. argot kap)

**Interfaces:**
- Produces: `evaluatePosition(p: PositionWithPrice, tp: { takeProfitPct: number; takeProfitFraction: number }): PositionAction`, ahol a `PositionAction` SELL ágain `qtyFraction: number` (nem literál).

- [ ] **Step 1: Frissítsd a teszteket az új 2. argra**

`tests/lib/strategy/position-actions.test.ts` — a fájl tetejére egy default tp-helper, és minden `evaluatePosition(pos(...))` hívás kapjon 2. argot `TP`:
```ts
const TP = { takeProfitPct: 0.15, takeProfitFraction: 0.5 };
// pl.: evaluatePosition(pos({ ...at(57000) }), TP)
```
Add egy ÚJ tesztet a configolható TP-re:
```ts
it("takeProfitFraction 1.0 → a teljes pozíciót zárja", () => {
  const a = evaluatePosition(pos({ entryPrice: 100, stopPrice: 95, low: 100, high: 116, close: 105 }), {
    takeProfitPct: 0.15, takeProfitFraction: 1.0,
  });
  expect(a.kind).toBe("take-profit");
  if (a.kind === "take-profit") expect(a.qtyFraction).toBe(1.0);
});
it("takeProfitPct 0.30 → +16% még NEM elég", () => {
  const a = evaluatePosition(pos({ entryPrice: 100, stopPrice: 95, low: 100, high: 116, close: 105 }), {
    takeProfitPct: 0.30, takeProfitFraction: 0.5,
  });
  expect(a.kind).toBe("none");
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/strategy/position-actions.test.ts`
Expected: FAIL — az `evaluatePosition` még 1 argot vár / `qtyFraction` literál.

- [ ] **Step 3: Implementáld**

`src/lib/strategy/position-actions.ts` — a `PROFIT_CYCLE` import KI; az action `qtyFraction: number`; a fv 2. arg `tp`:
```ts
export type PositionAction =
  | { kind: "none" }
  | { kind: "stop-loss"; side: "SELL"; qtyFraction: number; triggerPrice: number; reason: string }
  | { kind: "take-profit"; side: "SELL"; qtyFraction: number; triggerPrice: number; reason: string };

export function evaluatePosition(
  p: PositionWithPrice,
  tp: { takeProfitPct: number; takeProfitFraction: number },
): PositionAction {
  if (p.low <= p.stopPrice) {
    return {
      kind: "stop-loss", side: "SELL", qtyFraction: 1.0, triggerPrice: p.stopPrice,
      reason: `Stop-loss kiváltva: ${p.symbol} low ${p.low} ≤ stop ${p.stopPrice}`,
    };
  }
  const tpTrigger = p.entryPrice * (1 + tp.takeProfitPct);
  if (p.high >= tpTrigger) {
    return {
      kind: "take-profit", side: "SELL", qtyFraction: tp.takeProfitFraction, triggerPrice: tpTrigger,
      reason: `Take-profit: ${p.symbol} high elérte +${(tp.takeProfitPct * 100).toFixed(0)}% → ${(tp.takeProfitFraction * 100).toFixed(0)}% realizálás`,
    };
  }
  return { kind: "none" };
}
```
(A `PositionWithPrice` interfész változatlan.)

- [ ] **Step 4: Futtasd — a fájl tesztjei zöldek**

Run: `pnpm test tests/lib/strategy/position-actions.test.ts`
Expected: PASS. (A `profit-cycle.ts` hívása még a régi — a teljes suite Task 8 után lesz zöld; itt csak ez a fájl.)

- [ ] **Step 5: Ideiglenes hívás-javítás a fordításhoz**

`src/lib/engine/profit-cycle.ts` — az `evaluatePosition(...)` hívás kapjon 2. argot, hogy `tsc` ne törjön (Task 8-ban véglegesül):
```ts
const action = evaluatePosition(
  { positionId: p.id, symbol: p.symbol, qty: p.qty, entryPrice: p.entryPrice,
    stopPrice: effectiveStop, low: candle.low, high: candle.high, close: candle.close },
  { takeProfitPct: 0.15, takeProfitFraction: 0.5 },
);
```

- [ ] **Step 6: Teljes suite + tsc**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: PASS (130) + tsc 0. (A profit-cycle viselkedése változatlan, mert a hardcoded 0.15/0.5 = a régi.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/strategy/position-actions.ts tests/lib/strategy/position-actions.test.ts src/lib/engine/profit-cycle.ts
git commit -m "refactor(strategy): evaluatePosition take-profit configból (qtyFraction number)"
```

---

## Task 6: `evaluateDca` — config + trend-szűrő

**Files:**
- Modify: `src/lib/strategy/fear-greedy.ts`
- Modify: `tests/lib/strategy/fear-greedy.test.ts`
- Modify a hívó: `src/lib/engine/profit-cycle.ts` (ideiglenes, Task 8-ban véglegesül)

**Interfaces:**
- Produces: `evaluateDca(ctx: DcaContext, params: DcaParams): DcaSignal`, ahol `DcaContext` mostantól opcionális `trendOkBySymbol?: Record<string, boolean>`-ot is tartalmaz, és `DcaParams = { dcaFgThreshold, dcaMax24hDropPct, dcaBuyPct, entryFilter: "off" | "trend" }`.

- [ ] **Step 1: Frissítsd a teszteket (2. arg + trend-szűrő esetek)**

`tests/lib/strategy/fear-greedy.test.ts` — a fájl tetejére egy default params + minden `evaluateDca(ctx)` → `evaluateDca(ctx, P)`:
```ts
const P = { dcaFgThreshold: 25, dcaMax24hDropPct: 0.08, dcaBuyPct: 0.02, entryFilter: "off" as const };
```
Új tesztek:
```ts
it("trend-szűrő: a lefelé trendben lévő coin kiesik", () => {
  const s = evaluateDca(
    { fearGreedValue: 20, coinChanges: [{ symbol: "BTC", change24hPct: -3 }], weeklyBudgetRemainingUsd: 100, totalEquity: 1000, trendOkBySymbol: { BTC: false } },
    { ...P, entryFilter: "trend" },
  );
  expect(s.shouldAccumulate).toBe(false);
});
it("off módban a trendOk flaget figyelmen kívül hagyja", () => {
  const s = evaluateDca(
    { fearGreedValue: 20, coinChanges: [{ symbol: "BTC", change24hPct: -3 }], weeklyBudgetRemainingUsd: 100, totalEquity: 1000, trendOkBySymbol: { BTC: false } },
    { ...P, entryFilter: "off" },
  );
  expect(s.shouldAccumulate).toBe(true);
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/strategy/fear-greedy.test.ts`
Expected: FAIL — az `evaluateDca` még 1 argot vár.

- [ ] **Step 3: Implementáld**

`src/lib/strategy/fear-greedy.ts` — a `PROFIT_CYCLE` import KI; config + trend-szűrő:
```ts
export interface DcaContext {
  fearGreedValue: number | null;
  coinChanges: { symbol: string; change24hPct: number }[];
  weeklyBudgetRemainingUsd: number;
  totalEquity: number;
  trendOkBySymbol?: Record<string, boolean>;
}
export interface DcaParams {
  dcaFgThreshold: number;
  dcaMax24hDropPct: number;
  dcaBuyPct: number;
  entryFilter: "off" | "trend";
}

export function evaluateDca(ctx: DcaContext, params: DcaParams): DcaSignal {
  if (ctx.fearGreedValue === null) return noAccumulate("Nincs Fear & Greed adat — nem halmozunk vakon.");
  if (ctx.fearGreedValue > params.dcaFgThreshold)
    return noAccumulate(`Fear & Greed ${ctx.fearGreedValue} > ${params.dcaFgThreshold} — a piac nem elég olcsó.`);
  if (ctx.weeklyBudgetRemainingUsd <= 0) return noAccumulate("Elfogyott a heti DCA-keret.");

  const maxDropPoints = params.dcaMax24hDropPct * 100;
  let eligible = ctx.coinChanges.filter((c) => c.change24hPct > -maxDropPoints);
  if (params.entryFilter === "trend") {
    eligible = eligible.filter((c) => ctx.trendOkBySymbol?.[c.symbol] !== false);
  }
  if (eligible.length === 0) return noAccumulate("Nincs jogosult coin (zuhanás-küszöb / trend-szűrő).");

  const pick = eligible.reduce((min, c) => (c.change24hPct < min.change24hPct ? c : min));
  return {
    shouldAccumulate: true,
    symbol: pick.symbol,
    amountUsd: ctx.totalEquity * params.dcaBuyPct,
    reason: `Fear & Greed ${ctx.fearGreedValue} ≤ ${params.dcaFgThreshold} → ${pick.symbol} halmozása (${pick.change24hPct.toFixed(1)}% 24h).`,
  };
}
```

- [ ] **Step 4: Ideiglenes hívás-javítás**

`src/lib/engine/profit-cycle.ts` — az `evaluateDca` hívás kapjon 2. argot (Task 8-ban véglegesül):
```ts
const dca = evaluateDca(
  { fearGreedValue: input.fearGreedValue, coinChanges: input.coinChanges,
    weeklyBudgetRemainingUsd: input.weeklyBudgetRemainingUsd, totalEquity: input.totalEquity },
  { dcaFgThreshold: 25, dcaMax24hDropPct: 0.08, dcaBuyPct: 0.02, entryFilter: "off" },
);
```

- [ ] **Step 5: Teljes suite + tsc**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: PASS (132 — a fear-greedy fájl +2) + tsc 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategy/fear-greedy.ts tests/lib/strategy/fear-greedy.test.ts src/lib/engine/profit-cycle.ts
git commit -m "refactor(strategy): evaluateDca config + belépő-szűrő (trendOkBySymbol)"
```

---

## Task 7: `applyRisk` — heti-keret kapu KI az AI-BUY-ról + config-limitek

**Files:**
- Modify: `src/lib/risk/risk-manager.ts`
- Modify: `tests/lib/risk/risk-manager.test.ts`
- Modify a hívó: `src/lib/engine/tick.ts` (az `applyRisk` hívás 3. argot kap)

**Interfaces:**
- Produces: `applyRisk(raw: RawDecision, ctx: RiskContext, params: { maxPositionPct: number; maxConcurrentPositions: number; dailyLossCircuitBreakerPct: number }): Decision`. A `RiskContext`-ből a `weeklyBudgetRemainingUsd` **kikerül** (már nem gátolja az AI BUY-t).

- [ ] **Step 1: Frissítsd a teszteket (3. arg + új viselkedés)**

`tests/lib/risk/risk-manager.test.ts` — a fájl tetejére default params + minden `applyRisk(raw, ctx)` → `applyRisk(raw, ctx, RP)`:
```ts
const RP = { maxPositionPct: 0.2, maxConcurrentPositions: 3, dailyLossCircuitBreakerPct: 0.03 };
```
A korábbi „heti DCA-keret elfogyott → AI BUY HOLD" tesztet **cseréld** az ÚJ viselkedésre:
```ts
it("az AI BUY-t a heti DCA-keret NEM gátolja (a fagyás megszűnt)", () => {
  const d = applyRisk(
    { action: "BUY", symbol: "BTC", amountPct: 0.1, confidence: 0.6, reasoning: "", model: "x" },
    { cashUsd: 1000, positions: [], totalEquity: () => 1000, dayPnlPct: 0 },
    RP,
  );
  expect(d.action).toBe("BUY");
  expect(d.overridden).toBe(false);
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/risk/risk-manager.test.ts`
Expected: FAIL — az `applyRisk` még 2 argos / a heti-kapu még gátol.

- [ ] **Step 3: Implementáld**

`src/lib/risk/risk-manager.ts` — a `RISK_LIMITS` import KI; a `weeklyBudgetRemainingUsd` blokk TÖRÖLVE; a limitek a `params`-ból:
```ts
export interface RiskContext {
  cashUsd: number;
  positions: { symbol: string; valueUsd: number }[];
  totalEquity: () => number;
  dayPnlPct?: number;
}
export interface RiskParams {
  maxPositionPct: number;
  maxConcurrentPositions: number;
  dailyLossCircuitBreakerPct: number;
}

export function applyRisk(raw: RawDecision, ctx: RiskContext, params: RiskParams): Decision {
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  const base: Decision = { ...raw, id, timestamp, overridden: false };
  if (raw.action === "HOLD") return base;

  if ((ctx.dayPnlPct ?? 0) <= -params.dailyLossCircuitBreakerPct) {
    return { ...base, action: "HOLD", overridden: true,
      overrideReason: `Napi circuit breaker aktiválódott (${(ctx.dayPnlPct! * 100).toFixed(1)}% < -${(params.dailyLossCircuitBreakerPct * 100).toFixed(0)}%)` };
  }
  if (raw.action === "BUY" && raw.amountPct > params.maxPositionPct) {
    return { ...base, amountPct: params.maxPositionPct, overridden: true,
      overrideReason: `Max pozíció ${(params.maxPositionPct * 100).toFixed(0)}% tőke — visszavágva ${(raw.amountPct * 100).toFixed(0)}%-ról` };
  }
  const openSymbols = new Set(ctx.positions.map((p) => p.symbol));
  const isNewPosition = raw.action === "BUY" && raw.symbol && !openSymbols.has(raw.symbol);
  if (isNewPosition && openSymbols.size >= params.maxConcurrentPositions) {
    return { ...base, action: "HOLD", overridden: true,
      overrideReason: `Max ${params.maxConcurrentPositions} egyidejű pozíció — új coin nyitás elutasítva` };
  }
  return base;
}
```

- [ ] **Step 4: Hívó-javítás a tick.ts-ben**

`src/lib/engine/tick.ts` — az `applyRisk` hívásból a `weeklyBudgetRemainingUsd` KI, és 3. arg a limitekkel (a `DEFAULT_STRATEGY`-ből, Task 10-ben véglegesül; itt a mai konstansok):
```ts
import { RISK_LIMITS } from "@/lib/config";
// ...
const decision = applyRisk(
  rawDecision,
  { cashUsd, positions: workingPositions, totalEquity: totalEquityNow, dayPnlPct },
  { maxPositionPct: RISK_LIMITS.maxPositionPct, maxConcurrentPositions: RISK_LIMITS.maxConcurrentPositions, dailyLossCircuitBreakerPct: RISK_LIMITS.dailyLossCircuitBreakerPct },
);
```

- [ ] **Step 5: Teljes suite + tsc**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: PASS + tsc 0. (A heti-kapu teszt mostantól az ÚJ viselkedést várja; a többi változatlan.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/risk/risk-manager.ts tests/lib/risk/risk-manager.test.ts src/lib/engine/tick.ts
git commit -m "refactor(risk): heti DCA-keret nem gátolja az AI BUY-t + config-limitek"
```

---

## Task 8: `planProfitCycle` — `StrategyConfig` + ATR-stop + trend

**Files:**
- Modify: `src/lib/engine/profit-cycle.ts`
- Modify: `tests/lib/engine/profit-cycle.test.ts`

**Interfaces:**
- Consumes: `StrategyConfig` (Task 1), `evaluatePosition` (Task 5), `evaluateDca` (Task 6), `ratchetStop`.
- Produces: `planProfitCycle(input: ProfitCycleInput, config: StrategyConfig): ProfitCyclePlan`, ahol `ProfitCycleInput` mostantól `atrBySymbol: Record<string, number>` és `trendOkBySymbol: Record<string, boolean>` mezőket is tartalmaz (a `stopLossPct` mező KIKERÜL — a configból jön).

- [ ] **Step 1: Frissítsd a teszteket (2. arg = config + atr/trend mezők)**

`tests/lib/engine/profit-cycle.test.ts` — a `baseInput`-ból a `stopLossPct` KI, helyette `atrBySymbol: {}`, `trendOkBySymbol: {}`; minden `planProfitCycle(input)` → `planProfitCycle(input, DEFAULT_STRATEGY)`. Új teszt az ATR-stop ratchetre:
```ts
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
it("ATR-módban a ratchet az ATR-távolsággal kúszik", () => {
  const plan = planProfitCycle(
    { positions: [{ id: "p1", symbol: "BTC", qty: 0.01, entryPrice: 60000, stopPrice: 57000 }],
      candles: { BTC: { low: 64000, high: 66000, close: 65000 } },
      fearGreedValue: 50, coinChanges: [], weeklyBudgetRemainingUsd: 1000, totalEquity: 10000,
      atrBySymbol: { BTC: 1000 }, trendOkBySymbol: {} },
    { ...DEFAULT_STRATEGY, stopMode: "atr", atrMult: 2 },
  );
  // close 65000 − 2*1000 = 63000 > 57000 → stopUpdate 63000
  expect(plan.stopUpdates.find((u) => u.positionId === "p1")?.newStop).toBeCloseTo(63000, 0);
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/engine/profit-cycle.test.ts`
Expected: FAIL — `planProfitCycle` 1 argos / nincs config.

- [ ] **Step 3: Implementáld**

`src/lib/engine/profit-cycle.ts` — a `ProfitCycleInput`-ból `stopLossPct` KI, be `atrBySymbol`/`trendOkBySymbol`; a fv 2. arg `config`:
```ts
import type { StrategyConfig } from "@/lib/strategy/config";
import { evaluatePosition } from "@/lib/strategy/position-actions";
import { evaluateDca } from "@/lib/strategy/fear-greedy";
import { ratchetStop } from "@/lib/strategy/trailing-stop";

export interface ProfitCycleInput {
  positions: { id: string; symbol: string; qty: number; entryPrice: number; stopPrice: number }[];
  candles: Record<string, { low: number; high: number; close: number }>;
  fearGreedValue: number | null;
  coinChanges: { symbol: string; change24hPct: number }[];
  weeklyBudgetRemainingUsd: number;
  totalEquity: number;
  atrBySymbol: Record<string, number>;
  trendOkBySymbol: Record<string, boolean>;
}

export function planProfitCycle(input: ProfitCycleInput, config: StrategyConfig): ProfitCyclePlan {
  const orders: PlannedOrder[] = [];
  const stopUpdates: StopUpdate[] = [];

  for (const p of input.positions) {
    const candle = input.candles[p.symbol];
    if (!candle) continue;

    // Stop/TP az EREDETI stoppal (nincs look-ahead).
    const action = evaluatePosition(
      { positionId: p.id, symbol: p.symbol, qty: p.qty, entryPrice: p.entryPrice,
        stopPrice: p.stopPrice, low: candle.low, high: candle.high, close: candle.close },
      { takeProfitPct: config.takeProfitPct, takeProfitFraction: config.takeProfitFraction },
    );
    if (action.kind !== "none") {
      orders.push({ kind: action.kind, side: "SELL", symbol: p.symbol,
        qty: p.qty * action.qtyFraction, triggerPrice: action.triggerPrice, reason: action.reason });
    }

    // Trailing ratchet a KÖVETKEZŐ gyertyára — mód szerint.
    const atr = input.atrBySymbol[p.symbol] ?? 0;
    const candidate =
      config.stopMode === "atr" && atr > 0
        ? candle.close - config.atrMult * atr
        : candle.close * (1 - config.stopLossPct);
    const newStop = ratchetStop(p.stopPrice, candidate, 0); // ratchet csak max(prev, candidate)
    if (newStop > p.stopPrice) stopUpdates.push({ positionId: p.id, newStop });
  }

  // Fear-greedy DCA (config + trend-szűrő).
  const dca = evaluateDca(
    { fearGreedValue: input.fearGreedValue, coinChanges: input.coinChanges,
      weeklyBudgetRemainingUsd: input.weeklyBudgetRemainingUsd, totalEquity: input.totalEquity,
      trendOkBySymbol: input.trendOkBySymbol },
    { dcaFgThreshold: config.dcaFgThreshold, dcaMax24hDropPct: config.dcaMax24hDropPct,
      dcaBuyPct: config.dcaBuyPct, entryFilter: config.entryFilter },
  );
  if (dca.shouldAccumulate && dca.symbol) {
    orders.push({ kind: "dca", side: "BUY", symbol: dca.symbol, amountUsd: dca.amountUsd, reason: dca.reason });
  }

  return { orders, stopUpdates };
}
```
> **Megjegyzés a `ratchetStop(prev, candidate, 0)`-ról:** a `ratchetStop(currentStop, currentPrice, pct)` a `currentPrice*(1-pct)` és `currentStop` maximumát adja. `pct=0` → `max(currentStop, candidate)`, vagyis a már kiszámolt `candidate`-et használjuk ratchet-szabállyal (csak felfelé). Ez fixed és atr módban is helyes.

- [ ] **Step 4: Teljes suite + tsc + build**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm build`
Expected: a `profit-cycle` tesztek zöldek, DE a `tick.ts` és `engine.ts` hívása még a régi `ProfitCycleInput`-ot adja (stopLossPct) → **tsc HIBA**. Ezt a Task 9 (engine) és Task 10 (tick) javítja. **Itt csak a profit-cycle.test.ts-t futtasd:** `pnpm test tests/lib/engine/profit-cycle.test.ts` → PASS.

- [ ] **Step 5: Commit (a hívók a következő taskokban állnak helyre)**

```bash
git add src/lib/engine/profit-cycle.ts tests/lib/engine/profit-cycle.test.ts
git commit -m "refactor(engine): planProfitCycle StrategyConfig + ATR-stop + trend (hívók: Task 9-10)"
```

---

## Task 9: `runBacktest` — strategy + per-frame ATR/SMA

**Files:**
- Modify: `src/lib/backtest/engine.ts`
- Modify: `tests/lib/backtest/engine.test.ts`

**Interfaces:**
- Consumes: `planProfitCycle` (Task 8), `StrategyConfig`/`DEFAULT_STRATEGY` (Task 1), `computeAtr` (Task 2), `passesTrendFilter` (Task 3).
- Produces: `runBacktest(history: HistoryFrame[], config: BacktestConfig, strategy?: StrategyConfig): BacktestResult` (a `strategy` default = `DEFAULT_STRATEGY`).

- [ ] **Step 1: Frissítsd a teszteket (strategy 3. arg opcionális)**

`tests/lib/backtest/engine.test.ts` — a meglévő hívások maradhatnak (default strategy). Add egy ÚJ tesztet, hogy az ATR-mód config átmegy és nem dob:
```ts
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
it("ATR-stop konfiggal is lefut (nem dob), és ad eredményt", () => {
  const history = [
    frame(0, { o: 100, h: 100, l: 100, c: 100 }, 20),
    frame(1, { o: 100, h: 110, l: 95, c: 105 }, 50),
  ];
  const r = runBacktest(history, cfg, { ...DEFAULT_STRATEGY, stopMode: "atr", atrMult: 2 });
  expect(r.equityCurve).toHaveLength(2);
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/backtest/engine.test.ts`
Expected: FAIL — `runBacktest` még 2 argos / a `planProfitCycle` hívás a régi `ProfitCycleInput`-ot adja (tsc/futás hiba).

- [ ] **Step 3: Implementáld**

`src/lib/backtest/engine.ts` — a `RISK_LIMITS`/`PROFIT_CYCLE` használat helyett `strategy`; per-frame ATR/SMA; a stop-at-buy mód szerint:
```ts
import { DEFAULT_STRATEGY, type StrategyConfig } from "@/lib/strategy/config";
import { computeAtr } from "@/lib/strategy/atr";
import { passesTrendFilter } from "@/lib/strategy/entry-filter";
import { PROFIT_CYCLE } from "@/lib/config";
// (a RISK_LIMITS import elhagyható; a stop% a strategy-ből jön)

export function runBacktest(
  history: HistoryFrame[],
  config: BacktestConfig,
  strategy: StrategyConfig = DEFAULT_STRATEGY,
): BacktestResult {
  const frames = [...history].sort((a, b) => a.ts - b.ts);
  // ... (cashUsd, positions, equity, closedTrades, buyLog, hoursInMarket, nextId — változatlan)

  // Per-symbol gyertya-buffer az ATR/SMA-hoz.
  const buffers: Record<string, { high: number; low: number; close: number }[]> = {};

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    // ... MTM equity, hoursInMarket — változatlan ...

    // Buffer + ATR + trendOk per symbol.
    const atrBySymbol: Record<string, number> = {};
    const trendOkBySymbol: Record<string, boolean> = {};
    for (const sym of config.symbols) {
      const k = frame.candles[sym];
      if (!k) continue;
      const buf = (buffers[sym] ??= []);
      buf.push({ high: k.high, low: k.low, close: k.close });
      if (buf.length > 300) buf.shift();
      atrBySymbol[sym] = computeAtr(buf, strategy.atrPeriod);
      trendOkBySymbol[sym] = passesTrendFilter(buf.map((b) => b.close), strategy.entryFilterSmaPeriod);
    }

    // weeklyRemaining: strategy.dcaWeeklyBudgetPct.
    const weekAgo = frame.ts - 7 * 24 * HOUR;
    const spent7d = buyLog.filter((b) => b.ts > weekAgo).reduce((s, b) => s + b.amountUsd, 0);
    const weeklyRemaining = Math.max(0, strategy.dcaWeeklyBudgetPct * totalEquity - spent7d);

    // ... coinChanges, candles (low/high/close) — változatlan ...

    const plan = planProfitCycle(
      { positions: positions.map((p) => ({ id: p.id, symbol: p.symbol, qty: p.qty, entryPrice: p.entryPrice, stopPrice: p.stopPrice })),
        candles, fearGreedValue: frame.fearGreedValue, coinChanges,
        weeklyBudgetRemainingUsd: weeklyRemaining, totalEquity, atrBySymbol, trendOkBySymbol },
      strategy,
    );

    // ... stopUpdates, SELL-ek (változatlan) ...
    // BUY (DCA) — a stop mód szerint:
    // a meglévő BUY ágban a stopPrice számítását cseréld:
    //   const atr = atrBySymbol[o.symbol] ?? 0;
    //   const stopPrice = strategy.stopMode === "atr" && atr > 0
    //     ? fill.fillPrice - strategy.atrMult * atr
    //     : fill.fillPrice * (1 - strategy.stopLossPct);
    // és a pozíció létrehozásánál/növelésénél ezt a stopPrice-t használd.
  }
  // ... metrics + return — változatlan ...
}
```
> A meglévő `engine.ts` BUY-ágában a két `* (1 - RISK_LIMITS.stopLossPct)` előfordulást cseréld a fenti `stopPrice` változóra (mód-érzékeny). A `PROFIT_CYCLE.dcaWeeklyBudgetPct` → `strategy.dcaWeeklyBudgetPct`.

- [ ] **Step 4: Futtasd a backtest-teszteket**

Run: `pnpm test tests/lib/backtest/engine.test.ts tests/lib/backtest/walk-forward.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/engine.ts tests/lib/backtest/engine.test.ts
git commit -m "refactor(backtest): runBacktest StrategyConfig + per-frame ATR/SMA"
```

---

## Task 10: `tick.ts` — `DEFAULT_STRATEGY` + ATR/SMA (parity)

**Files:**
- Modify: `src/lib/engine/tick.ts`

**Interfaces:**
- Consumes: `planProfitCycle(input, config)` (Task 8), `DEFAULT_STRATEGY` (Task 1), `computeAtr`/`passesTrendFilter`.

**Cél:** a live tick a `DEFAULT_STRATEGY`-t adja a plannernek, és kiszámolja az `atrBySymbol`/`trendOkBySymbol`-t a Binance OHLC-ből (amit úgyis lekér). Mivel a default `stopMode:"fixed"` + `entryFilter:"off"`, a **viselkedés változatlan** → a 130 teszt zöld.

- [ ] **Step 1: Számold ki az ATR/SMA-t és add át a configot**

`src/lib/engine/tick.ts` — a profit-ciklus blokkban, a `planProfitCycle` hívás előtt:
```ts
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import { computeAtr } from "@/lib/strategy/atr";
import { passesTrendFilter } from "@/lib/strategy/entry-filter";
// ...
// A Binance OHLC events-ből per-symbol gyertya-sorozat (a buildFeatures is ezt eszi).
const ohlcBySymbol: Record<string, { high: number; low: number; close: number }[]> = {};
for (const e of events) {
  if (e.source === "binance" && e.kind === "price" && e.price) {
    (ohlcBySymbol[e.symbol] ??= []).push({ high: e.price.usd, low: e.price.usd, close: e.price.usd });
  }
}
const atrBySymbol: Record<string, number> = {};
const trendOkBySymbol: Record<string, boolean> = {};
for (const sym of COIN_UNIVERSE) {
  const buf = ohlcBySymbol[sym] ?? [];
  atrBySymbol[sym] = computeAtr(buf, DEFAULT_STRATEGY.atrPeriod);
  trendOkBySymbol[sym] = passesTrendFilter(buf.map((b) => b.close), DEFAULT_STRATEGY.entryFilterSmaPeriod);
}

const plan = planProfitCycle(
  { positions: workingPositions.map((p) => ({ id: p.id, symbol: p.symbol, qty: p.qty, entryPrice: p.entryPrice, stopPrice: p.stopPrice })),
    candles, fearGreedValue, coinChanges,
    weeklyBudgetRemainingUsd: weeklyRemaining, totalEquity: totalEquityNow(),
    atrBySymbol, trendOkBySymbol },
  DEFAULT_STRATEGY,
);
```
> A Binance OHLC `DataPoint` csak `price.usd`-t hordoz (nem külön high/low) — ezért a live ATR a close-okból degenerált (high=low=close). Ez elfogadható: a default `stopMode:"fixed"`, így az ATR nem befolyásolja a live viselkedést (parity). Ha később ATR-config kerül élesbe, a collector bővítendő valódi high/low-ra (külön feladat — jegyezd a [[project_ai_crypto_trader]]-be).

- [ ] **Step 2: Teljes suite + tsc + build (parity)**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm build`
Expected: **PASS (mind a ~136 teszt) + tsc 0 + build zöld.** A live viselkedés változatlan (default fixed/off).

- [ ] **Step 3: Commit**

```bash
git add src/lib/engine/tick.ts
git commit -m "refactor(engine): tick a DEFAULT_STRATEGY-t használja (parity, ATR/SMA bekötve)"
```

---

## Task 11: Tournament CLI

**Files:**
- Create: `scripts/tournament.ts`

**Interfaces:**
- Consumes: `loadHistory` (`src/lib/backtest/data.ts`), `runBacktest` (Task 9), `splitHistory`/`rankConfigs` (Task 4), `DEFAULT_STRATEGY`/`StrategyConfig` (Task 1), `COIN_UNIVERSE`.

- [ ] **Step 1: Írd meg a CLI-t**

`scripts/tournament.ts`:
```ts
/**
 * Variáns-tournament: gridet sweepel walk-forward módon, OOS Sharpe szerint rangsorol.
 * Futtatás: pnpm tsx scripts/tournament.ts [--pages N] [--min-trades M] [--top K]
 */
import { config as dotenv } from "dotenv";
dotenv({ path: ".env.local" });
dotenv();

async function main() {
  const { loadHistory } = await import("@/lib/backtest/data");
  const { runBacktest } = await import("@/lib/backtest/engine");
  const { splitHistory, rankConfigs } = await import("@/lib/backtest/walk-forward");
  const { DEFAULT_STRATEGY } = await import("@/lib/strategy/config");
  const { COIN_UNIVERSE } = await import("@/lib/config");
  type StrategyConfig = import("@/lib/strategy/config").StrategyConfig;

  const arg = (n: string, d: number) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? Number(process.argv[i + 1]) : d;
  };
  const pages = arg("pages", 5), minTrades = arg("min-trades", 15), top = arg("top", 15);

  // Grid (lásd spec §7).
  const grid: StrategyConfig[] = [];
  const tps = [0.1, 0.15, 0.25, 0.4];
  const tpFracs = [0.5, 1.0];
  const fgs = [20, 25, 35];
  const dcaBuys = [0.02, 0.04];
  const weeklies = [0.05, 0.1, 0.2];
  const filters: { entryFilter: "off" | "trend"; entryFilterSmaPeriod: number }[] = [
    { entryFilter: "off", entryFilterSmaPeriod: 24 },
    { entryFilter: "trend", entryFilterSmaPeriod: 24 },
    { entryFilter: "trend", entryFilterSmaPeriod: 72 },
  ];
  const stops: Partial<StrategyConfig>[] = [
    { stopMode: "fixed", stopLossPct: 0.04 }, { stopMode: "fixed", stopLossPct: 0.05 },
    { stopMode: "fixed", stopLossPct: 0.07 }, { stopMode: "fixed", stopLossPct: 0.1 },
    { stopMode: "atr", atrMult: 1.5 }, { stopMode: "atr", atrMult: 2 }, { stopMode: "atr", atrMult: 3 },
  ];
  for (const s of stops) for (const tp of tps) for (const tf of tpFracs) for (const fg of fgs)
    for (const db of dcaBuys) for (const wk of weeklies) for (const f of filters)
      grid.push({ ...DEFAULT_STRATEGY, ...s, takeProfitPct: tp, takeProfitFraction: tf,
        dcaFgThreshold: fg, dcaBuyPct: db, dcaWeeklyBudgetPct: wk, ...f });

  console.log(`Tournament: ${grid.length} config | ${pages} klines-lap | min OOS trade ${minTrades}`);
  const history = await loadHistory([...COIN_UNIVERSE], pages);
  const { inSample, outSample } = splitHistory(history, 0.7);
  const btCfg = { symbols: [...COIN_UNIVERSE], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 };

  const items = grid.map((cfg) => ({
    config: cfg,
    is: runBacktest(inSample, btCfg, cfg),
    oos: runBacktest(outSample, btCfg, cfg),
  }));

  // Baseline (default).
  const base = { config: DEFAULT_STRATEGY, is: runBacktest(inSample, btCfg, DEFAULT_STRATEGY), oos: runBacktest(outSample, btCfg, DEFAULT_STRATEGY) };
  const fmt = (r: typeof base.oos) => `ret ${(r.metrics.totalReturnPct * 100).toFixed(1)}% · Sharpe ${r.metrics.sharpe.toFixed(2)} · PF ${r.metrics.profitFactor.toFixed(2)} · ${r.metrics.tradesCount} trade`;
  console.log(`\n=== BASELINE (mai default) ===\n  IS:  ${fmt(base.is)}\n  OOS: ${fmt(base.oos)}`);

  const ranked = rankConfigs(items, minTrades);
  console.log(`\n=== TOP ${top} (OOS Sharpe; ${ranked.length} config a min-trade kapun túl) ===`);
  if (ranked.length === 0) { console.log("  Egyetlen config sem érte el a min-trade kaput az OOS-on."); return; }
  ranked.slice(0, top).forEach((r, i) => {
    const c = r.config;
    const stop = c.stopMode === "atr" ? `atr×${c.atrMult}` : `fix${(c.stopLossPct * 100).toFixed(0)}%`;
    console.log(`  #${i + 1} stop ${stop} · TP ${(c.takeProfitPct * 100).toFixed(0)}%/${c.takeProfitFraction} · FG${c.dcaFgThreshold} · dca ${(c.dcaBuyPct * 100).toFixed(0)}%/${(c.dcaWeeklyBudgetPct * 100).toFixed(0)}% · ${c.entryFilter}${c.entryFilter === "trend" ? c.entryFilterSmaPeriod : ""}`);
    console.log(`      IS:  ${fmt(r.is)}\n      OOS: ${fmt(r.oos)}`);
  });
  const beatsBaseline = ranked[0] && ranked[0].oos.metrics.sharpe > base.oos.metrics.sharpe;
  console.log(`\n${beatsBaseline ? "✅ A #1 config OOS-on VERI a defaultot — érdemes átvenni." : "ℹ️ Egyetlen config sem veri a default OOS Sharpe-ját — maradj a defaultnál."}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Futtasd (valódi adat, smoke + eredmény)**

Run: `pnpm tsx scripts/tournament.ts --pages 3`
Expected: kiír egy baseline-t + top‑15 leaderboardot + a „veri/nem veri" konklúziót, hibára-omlás nélkül.

- [ ] **Step 3: Teljes verifikáció**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm build`
Expected: minden zöld.

- [ ] **Step 4: Commit**

```bash
git add scripts/tournament.ts
git commit -m "feat(tournament): variáns-grid + walk-forward + OOS Sharpe leaderboard"
```

---

## Self-Review jegyzet (a szerző futtatta)

- **Spec-lefedettség:** §3 architektúra → Task 1–11; §4 StrategyConfig → Task 1; §5 ATR/filter → Task 2/3 (+ bekötés Task 8/9/10); §6 DCA-keret fix → Task 7; §7 grid → Task 11; §8 walk-forward → Task 4 (+ használat Task 11); §9 leaderboard → Task 11; §10 tesztterv → minden task TDD + a parity Task 5–10-ben.
- **Determinizmus:** `atr`/`entry-filter`/`walk-forward` nem hív `Date.now`/IO-t.
- **Type-konzisztencia:** `evaluatePosition(p, tp)` (Task 5) ↔ a hívás Task 8-ban azonos; `evaluateDca(ctx, params)` (Task 6) ↔ Task 8; `applyRisk(raw, ctx, params)` (Task 7) ↔ tick Task 7/10; `planProfitCycle(input, config)` az `atrBySymbol`/`trendOkBySymbol`/config mezőkkel egységesen Task 8/9/10-ben; `runBacktest(history, btConfig, strategy?)` Task 9 ↔ Task 11.
- **Parity:** a `DEFAULT_STRATEGY` minden refaktornál a mai értéket adja → a 130 teszt zöld; a Task 5/6 köztes commitjai szándékosan ideiglenes hardcode-ot hagynak a hívóban, amit Task 8–10 véglegesít (a teljes suite Task 10 után 100% zöld).
- **Nyitott (jegyzendő):** a live ATR a Binance `DataPoint` miatt degenerált (close-only); valódi high/low‑hoz a collector bővítése külön feladat — csak ha a tournament ATR-configot választ.

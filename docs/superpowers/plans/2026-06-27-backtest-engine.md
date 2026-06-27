# Backtest-motor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determinisztikus, reprodukálható backtest-motor, amely a kód-alapú profit-ciklust (stop-loss / take-profit / trailing / DCA) + Risk Managert futtatja történelmi OHLC-adaton, gyertya-szintű kitöltéssel, és Sharpe/max-drawdown/hit-rate metrikákat ad.

**Architecture:** A `runTick` drift-veszélyes, inline profit-ciklusát egy tiszta `planProfitCycle()` planner-be emeljük (a live tick ÉS a backtest is ezt hívja → nincs drift). A stop/TP trigger candle-aware lesz (`evaluatePosition` price-band: low/high/close). A backtest-motor összefűzi: history-loader → per-óra hurok → `planProfitCycle` → gyertya-fill-szimuláció → `applyRisk(HOLD)` → equity-rögzítés → metrikák. Az LLM kívül marad (Policy = HOLD; belépők a DCA-ból).

**Tech Stack:** TypeScript, Vitest (TDD), `@neondatabase/serverless` (a route-hoz), `tsx` (CLI), Binance klines REST + alternative.me Fear&Greed REST.

## Global Constraints

- A tiszta magok (`metrics`, `fill-sim`, `planProfitCycle`, `evaluatePosition`) **NEM hívnak** `Date.now()`-t, `Math.random()`-t, hálózatot vagy DB-t — az idő a gyertya-adatból jön (determinizmus, spec §8.5).
- A meglévő **106 teszt zöld kell maradjon** minden refaktor után (parity guard) — `pnpm test`.
- `pnpm exec tsc --noEmit` **0 hiba**; a kódbázis stílusa: magyar kommentek, `@/`-alias importok.
- Fee = `0.001` (0.1%, egyezik a PaperBroker-rel); slippage bps konfigurálható (default 5).
- Kezdőtőke default **10000 USD**; symbols = `COIN_UNIVERSE` (BTC/ETH/SOL).
- Konzervatív szabály: **stop tüzel előbb, mint a TP** ugyanazon a gyertyán — ezt az `evaluatePosition` stop-prioritása garantálja (nem külön flag). A ratchet **`close`-t** használ (nincs look-ahead).
- Minden teszt-fájl a meglévő mintát követi: `tests/lib/...` tükrözi a `src/lib/...` utat.

---

## File Structure

- `src/lib/backtest/types.ts` — **új** — közös backtest-típusok (`Candle`, `HistoryFrame`, `BacktestConfig`, `EquityPoint`, `ClosedTradePnl`, `BacktestMetrics`, `BacktestResult`).
- `src/lib/backtest/metrics.ts` — **új** — `computeMetrics()` (tiszta).
- `src/lib/backtest/fill-sim.ts` — **új** — `simulateFill()` (gyertya high/low + fee + slippage; tiszta).
- `src/lib/backtest/data.ts` — **új** — `alignFrames()` (tiszta) + `loadHistory()` (klines + F&G fetch).
- `src/lib/strategy/position-actions.ts` — **módosít** — `evaluatePosition` candle-aware (price-band).
- `src/lib/engine/profit-cycle.ts` — **új** — `planProfitCycle()` (tiszta, a `runTick`-ből kivonva).
- `src/lib/engine/tick.ts` — **módosít** — a profit-ciklus helyén `planProfitCycle()`-t hív + a tervet végrehajtja.
- `src/lib/backtest/engine.ts` — **új** — `runBacktest()` (a hurok, mindent összefűz).
- `scripts/backtest.ts` — **új** — CLI futtató.
- `src/app/api/backtest/route.ts` — **átír** — a naív vázlat helyett `runBacktest()`.

---

## Task 1: Backtest típusok + metrikák

**Files:**
- Create: `src/lib/backtest/types.ts`
- Create: `src/lib/backtest/metrics.ts`
- Test: `tests/lib/backtest/metrics.test.ts`

**Interfaces:**
- Produces: `computeMetrics(equity: EquityPoint[], closedTrades: ClosedTradePnl[], hoursInMarket: number): BacktestMetrics`
- Produces (types): `Candle`, `HistoryFrame`, `BacktestConfig`, `EquityPoint`, `ClosedTradePnl`, `BacktestMetrics`, `BacktestResult` (lásd a kód-blokkot).

- [ ] **Step 1: Írd meg a típusokat**

`src/lib/backtest/types.ts`:
```ts
/** Egy órás OHLC gyertya. */
export interface Candle {
  ts: number; // epoch ms (a gyertya nyitó órája)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Egy órás, time-aligned piaci keret: symbolonkénti gyertya + Fear&Greed. */
export interface HistoryFrame {
  ts: number;
  candles: Record<string, Candle>; // symbol -> gyertya (egy-egy symbol hiányozhat)
  fearGreedValue: number | null;
}

export interface BacktestConfig {
  symbols: string[];          // default COIN_UNIVERSE
  initialCapitalUsd: number;  // default 10000
  feePct: number;             // default 0.001
  slippageBps: number;        // default 5
}

export interface EquityPoint {
  ts: number;
  equityUsd: number;
}

/** Egy LEZÁRT (teljesen eladott) pozíció realizált eredménye. */
export interface ClosedTradePnl {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnlUsd: number;
  pnlPct: number;
}

export interface BacktestMetrics {
  totalReturnPct: number;
  sharpe: number;          // annualizált (√8760)
  maxDrawdownPct: number;  // pozitív szám (pl. 0.23 = -23% lehúzás)
  hitRate: number;         // 0..1
  tradesCount: number;     // lezárt pozíciók száma
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;    // Σwin / |Σloss|; loss nélkül Infinity
  exposurePct: number;     // piacban töltött órák aránya
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  closedTrades: ClosedTradePnl[];
  config: BacktestConfig;
  from: number;
  to: number;
}
```

- [ ] **Step 2: Írd meg a bukó tesztet**

`tests/lib/backtest/metrics.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeMetrics } from "@/lib/backtest/metrics";
import type { EquityPoint, ClosedTradePnl } from "@/lib/backtest/types";

const eq = (vals: number[]): EquityPoint[] => vals.map((v, i) => ({ ts: i * 3600_000, equityUsd: v }));

describe("computeMetrics", () => {
  it("total return a kezdő és vég equity arányából", () => {
    const m = computeMetrics(eq([100, 110]), [], 1);
    expect(m.totalReturnPct).toBeCloseTo(0.1, 6);
  });

  it("max drawdown a legnagyobb csúcs→völgy esés", () => {
    const m = computeMetrics(eq([100, 120, 90, 130]), [], 4);
    // csúcs 120 → völgy 90 → dd = 30/120 = 0.25
    expect(m.maxDrawdownPct).toBeCloseTo(0.25, 6);
  });

  it("hit rate + profit factor a lezárt trade-ekből", () => {
    const trades: ClosedTradePnl[] = [
      { symbol: "BTC", entryPrice: 100, exitPrice: 110, qty: 1, pnlUsd: 10, pnlPct: 0.1 },
      { symbol: "ETH", entryPrice: 100, exitPrice: 95, qty: 1, pnlUsd: -5, pnlPct: -0.05 },
    ];
    const m = computeMetrics(eq([100, 105]), trades, 2);
    expect(m.hitRate).toBeCloseTo(0.5, 6);
    expect(m.tradesCount).toBe(2);
    expect(m.profitFactor).toBeCloseTo(2, 6); // 10 / 5
    expect(m.avgWinPct).toBeCloseTo(0.1, 6);
    expect(m.avgLossPct).toBeCloseTo(-0.05, 6);
  });

  it("üres equity → nulla metrikák, nem dob", () => {
    const m = computeMetrics([], [], 0);
    expect(m.totalReturnPct).toBe(0);
    expect(m.sharpe).toBe(0);
  });

  it("exposure a piacban töltött órák aránya", () => {
    const m = computeMetrics(eq([100, 100, 100, 100]), [], 2);
    expect(m.exposurePct).toBeCloseTo(0.5, 6);
  });
});
```

- [ ] **Step 3: Futtasd — bukjon**

Run: `pnpm test tests/lib/backtest/metrics.test.ts`
Expected: FAIL — `computeMetrics` nincs definiálva.

- [ ] **Step 4: Implementáld**

`src/lib/backtest/metrics.ts`:
```ts
import type { EquityPoint, ClosedTradePnl, BacktestMetrics } from "./types";

const HOURS_PER_YEAR = 24 * 365; // 8760 — a kripto 24/7

/** Tiszta metrika-számítás az equity-görbéből + a lezárt trade-ekből. */
export function computeMetrics(
  equity: EquityPoint[],
  closedTrades: ClosedTradePnl[],
  hoursInMarket: number,
): BacktestMetrics {
  const empty: BacktestMetrics = {
    totalReturnPct: 0, sharpe: 0, maxDrawdownPct: 0, hitRate: 0,
    tradesCount: 0, avgWinPct: 0, avgLossPct: 0, profitFactor: 0, exposurePct: 0,
  };
  if (equity.length === 0) return empty;

  const first = equity[0].equityUsd;
  const last = equity[equity.length - 1].equityUsd;
  const totalReturnPct = first > 0 ? last / first - 1 : 0;

  // Órás hozamok → Sharpe (populációs szórás, rf=0, annualizált).
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].equityUsd;
    if (prev > 0) returns.push(equity[i].equityUsd / prev - 1);
  }
  let sharpe = 0;
  if (returns.length > 1) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(HOURS_PER_YEAR) : 0;
  }

  // Max drawdown.
  let peak = equity[0].equityUsd;
  let maxDd = 0;
  for (const p of equity) {
    if (p.equityUsd > peak) peak = p.equityUsd;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equityUsd) / peak);
  }

  // Trade-statisztika.
  const wins = closedTrades.filter((t) => t.pnlUsd > 0);
  const losses = closedTrades.filter((t) => t.pnlUsd < 0);
  const sumWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const sumLoss = losses.reduce((s, t) => s + t.pnlUsd, 0); // negatív
  const hitRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const profitFactor = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : (sumWin > 0 ? Infinity : 0);

  const exposurePct = equity.length > 0 ? hoursInMarket / equity.length : 0;

  return {
    totalReturnPct, sharpe, maxDrawdownPct: maxDd, hitRate,
    tradesCount: closedTrades.length, avgWinPct, avgLossPct, profitFactor, exposurePct,
  };
}
```

- [ ] **Step 5: Futtasd — passzoljon**

Run: `pnpm test tests/lib/backtest/metrics.test.ts`
Expected: PASS (5 teszt).

- [ ] **Step 6: Commit**

```bash
git add src/lib/backtest/types.ts src/lib/backtest/metrics.ts tests/lib/backtest/metrics.test.ts
git commit -m "feat(backtest): típusok + tiszta metrika-számítás (Sharpe/maxDD/hit-rate)"
```

---

## Task 2: Gyertya-fill szimuláció

**Files:**
- Create: `src/lib/backtest/fill-sim.ts`
- Test: `tests/lib/backtest/fill-sim.test.ts`

**Interfaces:**
- Consumes: `Candle` (Task 1).
- Produces: `simulateFill(req: FillRequest, feePct: number, slippageBps: number): SimFill | null`, és a típusok `FillRequest`, `SimFill`.

**Megjegyzés:** a fill-sim **csak az árat** számolja, feltételezve, hogy az order TÜZEL. Hogy tüzel-e (stop: `low ≤ trigger`, TP: `high ≥ trigger`), azt a planner (Task 4–5) dönti el az `evaluatePosition` candle-aware logikájával.

- [ ] **Step 1: Írd meg a bukó tesztet**

`tests/lib/backtest/fill-sim.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { simulateFill } from "@/lib/backtest/fill-sim";
import type { Candle } from "@/lib/backtest/types";

const candle = (o: number, h: number, l: number, c: number): Candle =>
  ({ ts: 0, open: o, high: h, low: l, close: c, volume: 0 });

describe("simulateFill", () => {
  it("stop-loss a trigger-áron tölt (nincs gap), slippage-dzsel lefelé", () => {
    const f = simulateFill(
      { side: "SELL", kind: "stop-loss", qty: 2, triggerPrice: 100, candle: candle(105, 106, 99, 101) },
      0.001, 10, // 0.1% fee, 10 bps slip
    )!;
    // base = min(100, open 105) = 100; fill = 100 * (1 - 0.001) = 99.9
    expect(f.fillPrice).toBeCloseTo(99.9, 6);
    expect(f.qty).toBeCloseTo(2, 6);
    expect(f.amountUsd).toBeCloseTo(99.9 * 2, 4);
  });

  it("stop-loss GAP-down: a rosszabb open-on tölt", () => {
    const f = simulateFill(
      { side: "SELL", kind: "stop-loss", qty: 1, triggerPrice: 100, candle: candle(94, 95, 90, 93) },
      0, 0,
    )!;
    // a gyertya a stop ALÁ nyit (open 94 < 100) → base = min(100, 94) = 94
    expect(f.fillPrice).toBeCloseTo(94, 6);
  });

  it("take-profit GAP-up: a jobb open-on tölt", () => {
    const f = simulateFill(
      { side: "SELL", kind: "take-profit", qty: 1, triggerPrice: 100, candle: candle(108, 110, 107, 109) },
      0, 0,
    )!;
    // base = max(100, open 108) = 108
    expect(f.fillPrice).toBeCloseTo(108, 6);
  });

  it("market BUY a close-on + slippage felfelé + fee", () => {
    const f = simulateFill(
      { side: "BUY", kind: "market", amountUsd: 100, candle: candle(50, 51, 49, 50) },
      0.001, 20, // 20 bps
    )!;
    // fillPrice = 50 * (1 + 0.002) = 50.1; qty = (100 - fee) / 50.1
    expect(f.fillPrice).toBeCloseTo(50.1, 6);
    expect(f.feeUsd).toBeCloseTo(0.1, 6);
    expect(f.qty).toBeCloseTo((100 - 0.1) / 50.1, 6);
    expect(f.amountUsd).toBeCloseTo(100, 6);
  });

  it("market SELL a close-on - slippage", () => {
    const f = simulateFill(
      { side: "SELL", kind: "market", qty: 2, candle: candle(50, 51, 49, 50) },
      0, 20,
    )!;
    expect(f.fillPrice).toBeCloseTo(49.9, 6); // 50 * (1 - 0.002)
  });

  it("nulla qty/amount → null", () => {
    expect(simulateFill({ side: "SELL", kind: "stop-loss", qty: 0, triggerPrice: 100, candle: candle(100,100,100,100) }, 0, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/backtest/fill-sim.test.ts`
Expected: FAIL — `simulateFill` nincs.

- [ ] **Step 3: Implementáld**

`src/lib/backtest/fill-sim.ts`:
```ts
import type { Candle } from "./types";

export interface FillRequest {
  side: "BUY" | "SELL";
  kind: "stop-loss" | "take-profit" | "market";
  qty?: number;          // SELL-hez (stop/TP/market-SELL)
  amountUsd?: number;    // BUY market-hez (USD-összeg)
  triggerPrice?: number; // stop/TP referencia-ár
  candle: Candle;
}

export interface SimFill {
  fillPrice: number;
  qty: number;
  amountUsd: number; // bruttó (qty * fillPrice)
  feeUsd: number;
}

/**
 * Egy order kitöltési árát számolja a gyertyából (a tüzelés tényét a hívó dönti el).
 *  - stop-loss SELL: min(trigger, open) − slippage  (gap-down a rosszabb open-on tölt)
 *  - take-profit SELL: max(trigger, open) − slippage (gap-up a jobb open-on tölt)
 *  - market BUY: close × (1 + slippage); market SELL: close × (1 − slippage)
 * Fee: BUY-nál az amountUsd-ből; SELL-nél a bruttóból. Tiszta — nincs IO/Date.now.
 */
export function simulateFill(req: FillRequest, feePct: number, slippageBps: number): SimFill | null {
  const slip = slippageBps / 10000;
  const c = req.candle;

  if (req.kind === "market" && req.side === "BUY") {
    const amountUsd = req.amountUsd ?? 0;
    if (amountUsd <= 0) return null;
    const fillPrice = c.close * (1 + slip);
    const feeUsd = amountUsd * feePct;
    const qty = (amountUsd - feeUsd) / fillPrice;
    if (qty <= 0) return null;
    return { fillPrice, qty, amountUsd, feeUsd };
  }

  // Minden más SELL (stop-loss / take-profit / market-SELL): qty alapú.
  const qty = req.qty ?? 0;
  if (qty <= 0) return null;
  let base: number;
  if (req.kind === "stop-loss") base = Math.min(req.triggerPrice!, c.open);
  else if (req.kind === "take-profit") base = Math.max(req.triggerPrice!, c.open);
  else base = c.close; // market SELL
  const fillPrice = base * (1 - slip);
  const gross = qty * fillPrice;
  const feeUsd = gross * feePct;
  return { fillPrice, qty, amountUsd: gross, feeUsd };
}
```

- [ ] **Step 4: Futtasd — passzoljon**

Run: `pnpm test tests/lib/backtest/fill-sim.test.ts`
Expected: PASS (6 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/fill-sim.ts tests/lib/backtest/fill-sim.test.ts
git commit -m "feat(backtest): gyertya-fill szimuláció (gap-aware stop/TP + fee + slippage)"
```

---

## Task 3: History-loader (klines + Fear&Greed)

**Files:**
- Create: `src/lib/backtest/data.ts`
- Test: `tests/lib/backtest/data.test.ts`

**Interfaces:**
- Consumes: `Candle`, `HistoryFrame` (Task 1).
- Produces: `alignFrames(candlesBySymbol: Record<string, Candle[]>, fgByHour: Map<number, number>): HistoryFrame[]` (tiszta), és `loadHistory(symbols: string[], pages?: number): Promise<HistoryFrame[]>` (fetch).

- [ ] **Step 1: Írd meg a bukó tesztet (a tiszta `alignFrames`-re)**

`tests/lib/backtest/data.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { alignFrames } from "@/lib/backtest/data";
import type { Candle } from "@/lib/backtest/types";

const c = (ts: number, close: number): Candle => ({ ts, open: close, high: close, low: close, close, volume: 1 });
const H = 3600_000;

describe("alignFrames", () => {
  it("órákra illeszt: minden óra-timestamp egy frame, a symbol-gyertyákkal", () => {
    const frames = alignFrames(
      { BTC: [c(0, 100), c(H, 101)], ETH: [c(0, 50), c(H, 51)] },
      new Map([[0, 20], [H, 22]]),
    );
    expect(frames).toHaveLength(2);
    expect(frames[0].ts).toBe(0);
    expect(frames[0].candles.BTC.close).toBe(100);
    expect(frames[0].candles.ETH.close).toBe(50);
    expect(frames[0].fearGreedValue).toBe(20);
  });

  it("hiányzó symbol-gyertya: a frame csak a meglévőt tartalmazza", () => {
    const frames = alignFrames({ BTC: [c(0, 100)], ETH: [c(H, 51)] }, new Map());
    const byTs = Object.fromEntries(frames.map((f) => [f.ts, f]));
    expect(byTs[0].candles.BTC).toBeDefined();
    expect(byTs[0].candles.ETH).toBeUndefined();
    expect(byTs[0].fearGreedValue).toBeNull();
  });

  it("a Fear&Greed a legközelebbi NEM-jövőbeli napi értékre esik (forward-fill)", () => {
    // F&G napi; egy nap = 24h. A 0-ás órára a 0-ás F&G, a 5*H órára is a 0-ás (nincs újabb).
    const frames = alignFrames({ BTC: [c(0, 100), c(5 * H, 100)] }, new Map([[0, 30]]));
    const byTs = Object.fromEntries(frames.map((f) => [f.ts, f]));
    expect(byTs[5 * H].fearGreedValue).toBe(30);
  });
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/backtest/data.test.ts`
Expected: FAIL — `alignFrames` nincs.

- [ ] **Step 3: Implementáld**

`src/lib/backtest/data.ts`:
```ts
import type { Candle, HistoryFrame } from "./types";

const HOUR = 3600_000;

/**
 * Time-aligned keretek a symbolonkénti gyertyákból + a Fear&Greed óra→érték map-ből.
 * Minden előforduló óra-timestamp egy frame. A F&G forward-fill: az adott órára a
 * legközelebbi NEM-jövőbeli ismert érték (a F&G napi, ezért óránként ismételjük). Tiszta.
 */
export function alignFrames(
  candlesBySymbol: Record<string, Candle[]>,
  fgByHour: Map<number, number>,
): HistoryFrame[] {
  // Az összes óra-timestamp összegyűjtése.
  const tsSet = new Set<number>();
  for (const arr of Object.values(candlesBySymbol)) for (const k of arr) tsSet.add(k.ts);
  const allTs = Array.from(tsSet).sort((a, b) => a - b);

  // F&G forward-fill: rendezett ismert pontok, és minden óra a ≤ts utolsó értéket kapja.
  const fgPoints = Array.from(fgByHour.entries()).sort((a, b) => a[0] - b[0]);
  const fgAt = (ts: number): number | null => {
    let val: number | null = null;
    for (const [t, v] of fgPoints) {
      if (t <= ts) val = v;
      else break;
    }
    return val;
  };

  // Gyors lookup: symbol -> (ts -> candle).
  const idx: Record<string, Map<number, Candle>> = {};
  for (const [sym, arr] of Object.entries(candlesBySymbol)) {
    idx[sym] = new Map(arr.map((k) => [k.ts, k]));
  }

  return allTs.map((ts) => {
    const candles: Record<string, Candle> = {};
    for (const sym of Object.keys(candlesBySymbol)) {
      const k = idx[sym].get(ts);
      if (k) candles[sym] = k;
    }
    return { ts, candles, fearGreedValue: fgAt(ts) };
  });
}

/** Binance 1h klines egy symbolra (a train-model.ts mintáját követi). */
async function fetchKlines(symbol: string, pages: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;
  for (let p = 0; p < pages; p++) {
    const u = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=1000${endTime ? `&endTime=${endTime}` : ""}`;
    const res = await fetch(u);
    if (!res.ok) { console.error(`[backtest/data] ${symbol} HTTP ${res.status}`); break; }
    const k = (await res.json()) as unknown[][];
    if (k.length === 0) break;
    for (const row of k) {
      out.push({
        ts: Number(row[0]),
        open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
        close: Number(row[4]), volume: Number(row[5]),
      });
    }
    endTime = Number(k[0][0]) - 1; // a következő lap a régebbi adat
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Fear&Greed history (alternative.me) → óra-timestamp → érték (a nap kezdő órájára). */
async function fetchFearGreed(limit = 0): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const res = await fetch(`https://api.alternative.me/fng/?limit=${limit}&format=json`);
    if (!res.ok) return map;
    const body = (await res.json()) as { data?: { value: string; timestamp: string }[] };
    for (const d of body.data ?? []) {
      const ts = Number(d.timestamp) * 1000; // sec → ms (a nap kezdete UTC)
      const hourTs = Math.floor(ts / HOUR) * HOUR;
      map.set(hourTs, Number(d.value));
    }
  } catch (e) {
    console.error("[backtest/data] F&G fetch hiba:", e);
  }
  return map;
}

/**
 * Teljes történelmi adat: symbolonkénti klines + F&G, time-aligned keretekké.
 * @param pages 1000-es klines lapok száma symbolonként (5 ≈ 5000 óra ≈ 208 nap).
 */
export async function loadHistory(symbols: string[], pages = 5): Promise<HistoryFrame[]> {
  const candlesBySymbol: Record<string, Candle[]> = {};
  for (const sym of symbols) candlesBySymbol[sym] = await fetchKlines(sym, pages);
  const fg = await fetchFearGreed(pages * 1000 / 24 + 10); // óra→nap durva felső becslés
  return alignFrames(candlesBySymbol, fg);
}
```

- [ ] **Step 4: Futtasd — passzoljon**

Run: `pnpm test tests/lib/backtest/data.test.ts`
Expected: PASS (3 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/data.ts tests/lib/backtest/data.test.ts
git commit -m "feat(backtest): history-loader (Binance klines + Fear&Greed) + tiszta alignFrames"
```

---

## Task 4: `evaluatePosition` candle-aware (price-band)

**Files:**
- Modify: `src/lib/strategy/position-actions.ts`
- Modify: `tests/lib/strategy/position-actions.test.ts`
- Modify: `src/lib/engine/tick.ts:260-267` (a hívó — degenerált band)

**Interfaces:**
- Produces: `evaluatePosition(p: PositionWithPrice): PositionAction`, ahol `PositionWithPrice` mostantól `low`, `high`, `close` mezőket tartalmaz (a `currentPrice` helyett), és `PositionAction` a SELL ágakon `triggerPrice: number`-t is ad vissza.

**Háttér:** a backtesthez a stop a gyertya `low`-jára, a TP a `high`-ra kell tüzeljen (intra-candle). A live ezt degenerált band-del (`low=high=close=spot`) használja → egy forrás, nincs drift.

- [ ] **Step 1: Frissítsd a meglévő teszteket az új band-API-ra (és add hozzá az intra-candle eseteket)**

`tests/lib/strategy/position-actions.test.ts` — a `currentPrice: X` mezőket cseréld `low/high/close`-ra. Példa-blokk a fájl ELEJÉRE egy helper + két ÚJ teszt; a meglévő eseteket a helperrel írd át:
```ts
import { describe, it, expect } from "vitest";
import { evaluatePosition } from "@/lib/strategy/position-actions";

// Degenerált band (mint élesben): low=high=close=ár.
const at = (price: number) => ({ low: price, high: price, close: price });

describe("evaluatePosition — candle-aware", () => {
  it("stop a gyertya LOW-jára tüzel (intra-candle), close a stop FÖLÖTT is", () => {
    const a = evaluatePosition({
      positionId: "p1", symbol: "BTC", qty: 1, entryPrice: 100, stopPrice: 95,
      low: 94, high: 101, close: 99, // close 99 > stop 95, DE low 94 ≤ 95
    });
    expect(a.kind).toBe("stop-loss");
    if (a.kind === "stop-loss") expect(a.triggerPrice).toBe(95);
  });

  it("take-profit a gyertya HIGH-jára tüzel (intra-candle)", () => {
    const a = evaluatePosition({
      positionId: "p1", symbol: "BTC", qty: 1, entryPrice: 100, stopPrice: 95,
      low: 100, high: 116, close: 105, // high 116 → +16% ≥ 15%
    });
    expect(a.kind).toBe("take-profit");
    if (a.kind === "take-profit") expect(a.triggerPrice).toBeCloseTo(115, 6); // entry*(1+0.15)
  });

  it("stop ÉS TP egy gyertyán → a STOP nyer (konzervatív)", () => {
    const a = evaluatePosition({
      positionId: "p1", symbol: "BTC", qty: 1, entryPrice: 100, stopPrice: 96,
      low: 95, high: 116, close: 100, // low ≤ 96 ÉS high → +16%
    });
    expect(a.kind).toBe("stop-loss");
  });

  it("nincs teendő: a band a stop és a TP között", () => {
    const a = evaluatePosition({
      positionId: "p1", symbol: "BTC", qty: 1, entryPrice: 100, stopPrice: 95,
      ...at(108),
    });
    expect(a.kind).toBe("none");
  });
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/strategy/position-actions.test.ts`
Expected: FAIL — a `PositionWithPrice` még `currentPrice`-t vár; `triggerPrice` nincs.

- [ ] **Step 3: Implementáld a candle-aware verziót**

`src/lib/strategy/position-actions.ts`:
```ts
import { PROFIT_CYCLE } from "@/lib/config";

/**
 * Kód-alapú pozíció-kezelés: stop-loss + take-profit. Tiszta függvény.
 * Candle-aware: a stop a gyertya LOW-jára, a TP a HIGH-jára tüzel (intra-candle).
 * Live: low=high=close=spot (degenerált band). Lásd backtest spec §5.
 */
export interface PositionWithPrice {
  positionId: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  low: number;
  high: number;
  close: number;
}

export type PositionAction =
  | { kind: "none" }
  | { kind: "stop-loss"; side: "SELL"; qtyFraction: 1.0; triggerPrice: number; reason: string }
  | { kind: "take-profit"; side: "SELL"; qtyFraction: 0.5; triggerPrice: number; reason: string };

/**
 *  - low ≤ stopPrice → stop-loss (TELJES pozíció), triggerPrice = stopPrice.
 *  - high alapú nyereség ≥ takeProfitPct → take-profit (FÉL pozíció), triggerPrice = entry*(1+tp).
 *  - stop-loss ELSŐBBSÉG (konzervatív: ugyanazon a gyertyán a stop nyer).
 */
export function evaluatePosition(p: PositionWithPrice): PositionAction {
  if (p.low <= p.stopPrice) {
    return {
      kind: "stop-loss", side: "SELL", qtyFraction: 1.0, triggerPrice: p.stopPrice,
      reason: `Stop-loss kiváltva: ${p.symbol} low ${p.low} ≤ stop ${p.stopPrice}`,
    };
  }
  const tpTrigger = p.entryPrice * (1 + PROFIT_CYCLE.takeProfitPct);
  if (p.high >= tpTrigger) {
    const gainPct = (tpTrigger - p.entryPrice) / p.entryPrice;
    return {
      kind: "take-profit", side: "SELL", qtyFraction: 0.5, triggerPrice: tpTrigger,
      reason: `Take-profit: ${p.symbol} high elérte +${(gainPct * 100).toFixed(0)}% → a pozíció felének realizálása`,
    };
  }
  return { kind: "none" };
}
```

- [ ] **Step 4: Frissítsd a `tick.ts` hívót (degenerált band + triggerPrice)**

`src/lib/engine/tick.ts` — a profit-ciklus blokkban (≈260–270. sor) az `evaluatePosition` hívás a `currentPrice` helyett band-et kap; a SELL ár a `triggerPrice` (ami live-on = currentPrice):
```ts
      const action = evaluatePosition({
        positionId: p.id,
        symbol: p.symbol,
        qty: p.qty,
        entryPrice: p.entryPrice,
        stopPrice: p.stopPrice,
        low: currentPrice, high: currentPrice, close: currentPrice,
      });
      if (action.kind === "none") continue;
      const sellQty = p.qty * action.qtyFraction;
      const trade = await executeCycleOrder("SELL", p.symbol, { qty: sellQty }, action.triggerPrice);
```

- [ ] **Step 5: Futtasd a teljes suite-ot — minden zöld (parity)**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: PASS — 106 + az új 4 candle-aware teszt; `tsc` 0. (A live `triggerPrice` = `currentPrice`, így a tick-tesztek viselkedése változatlan.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategy/position-actions.ts tests/lib/strategy/position-actions.test.ts src/lib/engine/tick.ts
git commit -m "refactor(strategy): evaluatePosition candle-aware (low/high band + triggerPrice)"
```

---

## Task 5: `planProfitCycle` kivonatolása (tiszta planner)

**Files:**
- Create: `src/lib/engine/profit-cycle.ts`
- Test: `tests/lib/engine/profit-cycle.test.ts`

**Interfaces:**
- Consumes: `evaluatePosition` (Task 4), `evaluateDca`, `ratchetStop`, `PROFIT_CYCLE`.
- Produces: `planProfitCycle(input: ProfitCycleInput): ProfitCyclePlan`, és a típusok `ProfitCycleInput`, `ProfitCyclePlan`, `PlannedOrder`, `StopUpdate`.

**Megjegyzés:** ez a planner a `runTick` profit-ciklusának **döntés-része** I/O nélkül. A Task 6 (engine) és a Task 7 (tick-refaktor) is ezt hívja. A végrehajtás (cash/pozíció-mutáció) a hívóé.

- [ ] **Step 1: Írd meg a bukó tesztet**

`tests/lib/engine/profit-cycle.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { planProfitCycle } from "@/lib/engine/profit-cycle";

const baseInput = {
  positions: [{ id: "p1", symbol: "BTC", qty: 0.01, entryPrice: 60000, stopPrice: 57000 }],
  candles: { BTC: { low: 56000, high: 61000, close: 58000 } }, // low ≤ stop 57000 → stop tüzel
  fearGreedValue: 50,
  coinChanges: [{ symbol: "BTC", change24hPct: -2 }],
  weeklyBudgetRemainingUsd: 1000,
  totalEquity: 10000,
  stopLossPct: 0.05,
};

describe("planProfitCycle", () => {
  it("stop-loss order, ha a low átszúrja a stopot", () => {
    const plan = planProfitCycle(baseInput);
    const stop = plan.orders.find((o) => o.kind === "stop-loss");
    expect(stop).toBeDefined();
    expect(stop!.side).toBe("SELL");
    expect(stop!.qty).toBeCloseTo(0.01, 9);
    expect(stop!.triggerPrice).toBe(57000);
  });

  it("ratchet stop-update emelkedő árnál (close-alapú, nincs look-ahead)", () => {
    const plan = planProfitCycle({
      ...baseInput,
      positions: [{ id: "p1", symbol: "BTC", qty: 0.01, entryPrice: 60000, stopPrice: 57000 }],
      candles: { BTC: { low: 64000, high: 66000, close: 65000 } }, // nem tüzel; close 65000 → új stop 61750
    });
    const upd = plan.stopUpdates.find((u) => u.positionId === "p1");
    expect(upd).toBeDefined();
    expect(upd!.newStop).toBeCloseTo(61750, 0); // 65000 * 0.95
    expect(plan.orders.find((o) => o.kind === "stop-loss")).toBeUndefined();
  });

  it("DCA BUY, ha F&G ≤ küszöb és van keret", () => {
    const plan = planProfitCycle({
      ...baseInput,
      candles: { BTC: { low: 59000, high: 61000, close: 60000 } }, // nem tüzel a stop
      fearGreedValue: 20, // ≤ 25
    });
    const dca = plan.orders.find((o) => o.kind === "dca");
    expect(dca).toBeDefined();
    expect(dca!.side).toBe("BUY");
    expect(dca!.amountUsd).toBeCloseTo(10000 * 0.02, 6); // dcaBuyPct
  });

  it("nincs DCA, ha a heti keret elfogyott", () => {
    const plan = planProfitCycle({
      ...baseInput,
      candles: { BTC: { low: 59000, high: 61000, close: 60000 } },
      fearGreedValue: 20,
      weeklyBudgetRemainingUsd: 0,
    });
    expect(plan.orders.find((o) => o.kind === "dca")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/engine/profit-cycle.test.ts`
Expected: FAIL — `planProfitCycle` nincs.

- [ ] **Step 3: Implementáld**

`src/lib/engine/profit-cycle.ts`:
```ts
import { PROFIT_CYCLE } from "@/lib/config";
import { evaluatePosition } from "@/lib/strategy/position-actions";
import { evaluateDca } from "@/lib/strategy/fear-greedy";
import { ratchetStop } from "@/lib/strategy/trailing-stop";

export interface PlannedOrder {
  kind: "stop-loss" | "take-profit" | "dca";
  side: "BUY" | "SELL";
  symbol: string;
  qty?: number;          // SELL (stop/TP)
  amountUsd?: number;    // BUY (DCA)
  triggerPrice?: number; // SELL fill-referencia
  reason: string;
}

export interface StopUpdate {
  positionId: string;
  newStop: number;
}

export interface ProfitCyclePlan {
  orders: PlannedOrder[];
  stopUpdates: StopUpdate[];
}

export interface ProfitCycleInput {
  positions: { id: string; symbol: string; qty: number; entryPrice: number; stopPrice: number }[];
  candles: Record<string, { low: number; high: number; close: number }>;
  fearGreedValue: number | null;
  coinChanges: { symbol: string; change24hPct: number }[];
  weeklyBudgetRemainingUsd: number;
  totalEquity: number;
  stopLossPct: number;
}

/**
 * A kód-alapú profit-ciklus DÖNTÉS-része, tisztán (nincs IO/DB/Date.now).
 * Sorrend (a runTick tükre): trailing ratchet (close-alapú) → stop/TP → DCA.
 * A hívó hajtja végre az ordereket (cash/pozíció-mutáció) + perzisztálja a stopUpdate-eket.
 */
export function planProfitCycle(input: ProfitCycleInput): ProfitCyclePlan {
  const orders: PlannedOrder[] = [];
  const stopUpdates: StopUpdate[] = [];

  for (const p of input.positions) {
    const candle = input.candles[p.symbol];
    if (!candle) continue;

    // 1) Trailing ratchet a close-szal (nincs look-ahead).
    const newStop = ratchetStop(p.stopPrice, candle.close, input.stopLossPct);
    const effectiveStop = Math.max(p.stopPrice, newStop);
    if (newStop > p.stopPrice) stopUpdates.push({ positionId: p.id, newStop });

    // 2) Stop/TP a candle-band-del (a ratchetelt stoppal).
    const action = evaluatePosition({
      positionId: p.id, symbol: p.symbol, qty: p.qty, entryPrice: p.entryPrice,
      stopPrice: effectiveStop, low: candle.low, high: candle.high, close: candle.close,
    });
    if (action.kind !== "none") {
      orders.push({
        kind: action.kind, side: "SELL", symbol: p.symbol,
        qty: p.qty * action.qtyFraction, triggerPrice: action.triggerPrice, reason: action.reason,
      });
    }
  }

  // 3) Fear-greedy DCA.
  const dca = evaluateDca({
    fearGreedValue: input.fearGreedValue,
    coinChanges: input.coinChanges,
    weeklyBudgetRemainingUsd: input.weeklyBudgetRemainingUsd,
    totalEquity: input.totalEquity,
  });
  if (dca.shouldAccumulate && dca.symbol) {
    orders.push({
      kind: "dca", side: "BUY", symbol: dca.symbol, amountUsd: dca.amountUsd, reason: dca.reason,
    });
  }

  return { orders, stopUpdates };
}
```

- [ ] **Step 4: Futtasd — passzoljon**

Run: `pnpm test tests/lib/engine/profit-cycle.test.ts`
Expected: PASS (4 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/profit-cycle.ts tests/lib/engine/profit-cycle.test.ts
git commit -m "feat(engine): planProfitCycle tiszta planner (stop/TP/DCA döntés, IO nélkül)"
```

---

## Task 6: `runTick` átkötése `planProfitCycle`-re (parity-refaktor)

**Files:**
- Modify: `src/lib/engine/tick.ts:243-319` (a profit-ciklus blokk)

**Interfaces:**
- Consumes: `planProfitCycle` (Task 5).
- Produces: változatlan `runTick` külső viselkedés (a 106 + a Task 4/5 tesztek a guard).

**Cél:** a `runTick` inline profit-ciklusa helyett `planProfitCycle()`-t hív, majd a kapott ordereket a meglévő `executeCycleOrder`-rel hajtja végre, a `stopUpdates`-et `setStopPrice`-szal perzisztálja. **Nincs új viselkedés** — csak a döntés-logika kerül a közös planner-be.

- [ ] **Step 1: Cseréld a profit-ciklus blokkot**

`src/lib/engine/tick.ts` — a `if (dbState) { ... }` profit-ciklus blokk (≈243–319. sor) belsejét cseréld erre (a `executeCycleOrder`, `recordTrade`, `cycleActions`, `weeklyRemaining` változók megmaradnak feljebb):
```ts
  if (dbState) {
    // Heti keret a planhez (a meglévő totalEquityNow alapján).
    weeklyRemaining = await remainingWeeklyBudget(totalEquityNow());

    // 24h változás a CoinGecko ár-pontból (a kosár coinjaira).
    const coinChanges = events
      .filter(
        (e) => e.source === "coingecko" && e.kind === "price" && e.price !== undefined &&
          (COIN_UNIVERSE as readonly string[]).includes(e.symbol),
      )
      .map((e) => ({ symbol: e.symbol, change24hPct: e.price!.change24hPct }));
    const fgEvent = events.find((e) => e.kind === "sentiment" && e.sentiment);
    const fearGreedValue = fgEvent?.sentiment?.value ?? null;

    // Live candle-band: low=high=close=aktuális ár (csak spot ismert).
    const candles: Record<string, { low: number; high: number; close: number }> = {};
    for (const p of workingPositions) {
      const px = prices[p.symbol];
      if (px !== undefined) candles[p.symbol] = { low: px, high: px, close: px };
    }

    const plan = planProfitCycle({
      positions: workingPositions.map((p) => ({
        id: p.id, symbol: p.symbol, qty: p.qty, entryPrice: p.entryPrice, stopPrice: p.stopPrice,
      })),
      candles,
      fearGreedValue,
      coinChanges,
      weeklyBudgetRemainingUsd: weeklyRemaining,
      totalEquity: totalEquityNow(),
      stopLossPct: RISK_LIMITS.stopLossPct,
    });

    // Stop-update-ek perzisztálása + munka-állapot frissítése.
    for (const u of plan.stopUpdates) {
      const pos = workingPositions.find((p) => p.id === u.positionId);
      if (pos) pos.stopPrice = u.newStop;
      await setStopPrice(u.positionId, u.newStop);
    }

    // Orderek végrehajtása (a SELL-ek előbb, hogy a cash a DCA-nak rendelkezésre álljon).
    const sells = plan.orders.filter((o) => o.side === "SELL");
    const buys = plan.orders.filter((o) => o.side === "BUY");
    for (const o of [...sells, ...buys]) {
      const px = prices[o.symbol];
      if (px === undefined) continue;
      const fillPrice = o.triggerPrice ?? px;
      const trade =
        o.side === "SELL"
          ? await executeCycleOrder("SELL", o.symbol, { qty: o.qty }, fillPrice)
          : await executeCycleOrder("BUY", o.symbol, { amountUsd: o.amountUsd }, px);
      if (trade) {
        cycleActions.push({ kind: o.kind, side: o.side, symbol: o.symbol, amountUsd: trade.amountUsd, qty: trade.qty });
        if (o.side === "BUY") weeklyRemaining -= trade.amountUsd;
      }
    }
  }
```
Majd a fájl tetején add az importot: `import { planProfitCycle } from "@/lib/engine/profit-cycle";`

- [ ] **Step 2: Futtasd a teljes suite-ot — parity**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: PASS — a 106 + új tesztek. **Ha egy `tick-profit-cycle` teszt bukik:** a planner-sorrendet (ratchet→stop/TP→DCA) és a SELL-előbb-mint-BUY végrehajtást igazítsd, amíg zöld (a cél: bitre azonos kötés-viselkedés). Ne módosítsd a teszteket a parity kedvéért — a kódot igazítsd.

- [ ] **Step 3: Futtasd a build-et**

Run: `pnpm build`
Expected: zöld (a route-ok fordulnak).

- [ ] **Step 4: Commit**

```bash
git add src/lib/engine/tick.ts
git commit -m "refactor(engine): runTick a közös planProfitCycle-t használja (parity, 106 zöld)"
```

---

## Task 7: Backtest-motor hurok (`runBacktest`)

**Files:**
- Create: `src/lib/backtest/engine.ts`
- Test: `tests/lib/backtest/engine.test.ts`

**Interfaces:**
- Consumes: `planProfitCycle` (Task 5), `simulateFill` (Task 2), `computeMetrics` (Task 1), `applyRisk`, `buildFeatures`/`predict`, `HistoryFrame`, `BacktestConfig`, `BacktestResult`.
- Produces: `runBacktest(history: HistoryFrame[], config: BacktestConfig): BacktestResult`.

- [ ] **Step 1: Írd meg a bukó tesztet (szintetikus history, ismert kimenet)**

`tests/lib/backtest/engine.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { runBacktest } from "@/lib/backtest/engine";
import type { HistoryFrame, BacktestConfig } from "@/lib/backtest/types";

const H = 3600_000;
const frame = (i: number, btc: { o: number; h: number; l: number; c: number }, fg: number | null): HistoryFrame => ({
  ts: i * H,
  candles: { BTC: { ts: i * H, open: btc.o, high: btc.h, low: btc.l, close: btc.c, volume: 1 } },
  fearGreedValue: fg,
});

const cfg: BacktestConfig = { symbols: ["BTC"], initialCapitalUsd: 10000, feePct: 0.001, slippageBps: 5 };

describe("runBacktest", () => {
  it("DCA-belépő extrém félelemnél, majd take-profit emelkedésnél → pozitív return", () => {
    const history: HistoryFrame[] = [
      frame(0, { o: 100, h: 100, l: 100, c: 100 }, 20), // F&G 20 ≤ 25 → DCA BUY
      frame(1, { o: 100, h: 130, l: 100, c: 125 }, 50), // +25% high → take-profit (fél pozíció)
      frame(2, { o: 125, h: 126, l: 124, c: 125 }, 50),
    ];
    const result = runBacktest(history, cfg);
    expect(result.equityCurve).toHaveLength(3);
    expect(result.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(result.config.initialCapitalUsd).toBe(10000);
  });

  it("stop-loss zuhanásnál → lezárt trade + negatív hozam azon a pozíción", () => {
    const history: HistoryFrame[] = [
      frame(0, { o: 100, h: 100, l: 100, c: 100 }, 20), // DCA BUY @ ~100, stop ~95
      frame(1, { o: 100, h: 100, l: 90, c: 92 }, 50),   // low 90 ≤ stop 95 → stop-loss (teljes)
    ];
    const result = runBacktest(history, cfg);
    expect(result.closedTrades.length).toBeGreaterThanOrEqual(1);
    expect(result.metrics.tradesCount).toBeGreaterThanOrEqual(1);
  });

  it("üres history → nulla metrikák, nem dob", () => {
    const result = runBacktest([], cfg);
    expect(result.metrics.totalReturnPct).toBe(0);
    expect(result.equityCurve).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Futtasd — bukjon**

Run: `pnpm test tests/lib/backtest/engine.test.ts`
Expected: FAIL — `runBacktest` nincs.

- [ ] **Step 3: Implementáld**

`src/lib/backtest/engine.ts`:
```ts
import type { HistoryFrame, BacktestConfig, BacktestResult, EquityPoint, ClosedTradePnl } from "./types";
import { planProfitCycle } from "@/lib/engine/profit-cycle";
import { simulateFill } from "./fill-sim";
import { computeMetrics } from "./metrics";
import { buildFeatures } from "@/lib/ml/features";
import { predict } from "@/lib/ml/predictor";
import { applyRisk } from "@/lib/risk/risk-manager";
import { PROFIT_CYCLE, RISK_LIMITS, COIN_UNIVERSE } from "@/lib/config";
import type { DataPoint } from "@/lib/types";

interface SimPosition { symbol: string; qty: number; entryPrice: number; stopPrice: number; }

const HOUR = 3600_000;

/**
 * Determinisztikus backtest: a runTick profit-ciklusát (planProfitCycle) futtatja
 * történelmi kereteken, gyertya-fill szimulációval. Policy = HOLD (LLM kívül; belépők a DCA).
 * Tiszta a hálózat felé — a history-t a hívó tölti be (data.ts). Nincs Date.now.
 */
export function runBacktest(history: HistoryFrame[], config: BacktestConfig): BacktestResult {
  const frames = [...history].sort((a, b) => a.ts - b.ts);
  let cashUsd = config.initialCapitalUsd;
  let positions: SimPosition[] = [];
  const equity: EquityPoint[] = [];
  const closedTrades: ClosedTradePnl[] = [];
  const buyLog: { ts: number; amountUsd: number }[] = []; // gördülő heti keret
  let hoursInMarket = 0;

  const closeBySymbolAt = (frame: HistoryFrame, sym: string): number | undefined =>
    frame.candles[sym]?.close;

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];

    // MTM equity (cash + pozíciók close-on).
    const posValue = positions.reduce((s, p) => {
      const px = closeBySymbolAt(frame, p.symbol) ?? p.entryPrice;
      return s + px * p.qty;
    }, 0);
    const totalEquity = cashUsd + posValue;
    if (positions.length > 0) hoursInMarket++;

    // Heti DCA-keret: dcaWeeklyBudgetPct * equity − az utolsó 7 nap BUY-jai.
    const weekAgo = frame.ts - 7 * 24 * HOUR;
    const spent7d = buyLog.filter((b) => b.ts > weekAgo).reduce((s, b) => s + b.amountUsd, 0);
    const weeklyRemaining = Math.max(0, PROFIT_CYCLE.dcaWeeklyBudgetPct * totalEquity - spent7d);

    // 24h változás a close-okból (24 frame-mel korábbi close).
    const prevFrame = frames[fi - 24];
    const coinChanges = config.symbols.map((sym) => {
      const now = closeBySymbolAt(frame, sym);
      const before = prevFrame ? closeBySymbolAt(prevFrame, sym) : undefined;
      const change24hPct = now && before ? ((now - before) / before) * 100 : 0;
      return { symbol: sym, change24hPct };
    });

    // Candle-band a planhez.
    const candles: Record<string, { low: number; high: number; close: number }> = {};
    for (const sym of config.symbols) {
      const k = frame.candles[sym];
      if (k) candles[sym] = { low: k.low, high: k.high, close: k.close };
    }

    const plan = planProfitCycle({
      positions: positions.map((p, i) => ({ id: String(i), ...p })),
      candles,
      fearGreedValue: frame.fearGreedValue,
      coinChanges,
      weeklyBudgetRemainingUsd: weeklyRemaining,
      totalEquity,
      stopLossPct: RISK_LIMITS.stopLossPct,
    });

    // Stop-update-ek.
    for (const u of plan.stopUpdates) {
      const idx = Number(u.positionId);
      if (positions[idx]) positions[idx].stopPrice = u.newStop;
    }

    // Orderek: SELL-ek előbb, majd BUY-ok (cash-feeding).
    const ordered = [...plan.orders].sort((a, b) => (a.side === "SELL" ? -1 : 1) - (b.side === "SELL" ? -1 : 1));
    for (const o of ordered) {
      const k = frame.candles[o.symbol];
      if (!k) continue;
      if (o.side === "SELL") {
        const pos = positions.find((p) => p.symbol === o.symbol);
        if (!pos) continue;
        const fill = simulateFill(
          { side: "SELL", kind: o.kind === "dca" ? "market" : o.kind, qty: Math.min(o.qty ?? 0, pos.qty), triggerPrice: o.triggerPrice, candle: k },
          config.feePct, config.slippageBps,
        );
        if (!fill) continue;
        cashUsd += fill.amountUsd - fill.feeUsd;
        pos.qty -= fill.qty;
        // Lezárt-e (teljes stop) → realizált PnL.
        if (pos.qty <= 1e-7) {
          closedTrades.push({
            symbol: pos.symbol, entryPrice: pos.entryPrice, exitPrice: fill.fillPrice, qty: fill.qty,
            pnlUsd: (fill.fillPrice - pos.entryPrice) * fill.qty,
            pnlPct: (fill.fillPrice - pos.entryPrice) / pos.entryPrice,
          });
          positions = positions.filter((p) => p !== pos);
        }
      } else {
        // BUY (DCA) — clamp a cash-re.
        const amountUsd = Math.min(o.amountUsd ?? 0, Math.max(0, cashUsd));
        if (amountUsd <= 0) continue;
        const fill = simulateFill({ side: "BUY", kind: "market", amountUsd, candle: k }, config.feePct, config.slippageBps);
        if (!fill) continue;
        cashUsd -= amountUsd;
        buyLog.push({ ts: frame.ts, amountUsd });
        const ex = positions.find((p) => p.symbol === o.symbol);
        if (ex) {
          const newQty = ex.qty + fill.qty;
          ex.entryPrice = (ex.qty * ex.entryPrice + fill.qty * fill.fillPrice) / newQty;
          ex.qty = newQty;
          ex.stopPrice = fill.fillPrice * (1 - RISK_LIMITS.stopLossPct);
        } else {
          positions.push({ symbol: o.symbol, qty: fill.qty, entryPrice: fill.fillPrice, stopPrice: fill.fillPrice * (1 - RISK_LIMITS.stopLossPct) });
        }
      }
    }

    // Policy = HOLD (MVP) → applyRisk csak HOLD-ot ad vissza, nincs AI-trade.
    // (A seam megvan a későbbi ML-policyhoz; az MVP nem hív AI-belépőt.)
    void applyRisk; void buildFeatures; void predict; void COIN_UNIVERSE; // jövő-seam, jelenleg nincs AI-belépő
    void ({} as DataPoint);

    equity.push({ ts: frame.ts, equityUsd: cashUsd + positions.reduce((s, p) => s + (closeBySymbolAt(frame, p.symbol) ?? p.entryPrice) * p.qty, 0) });
  }

  return {
    metrics: computeMetrics(equity, closedTrades, hoursInMarket),
    equityCurve: equity,
    closedTrades,
    config,
    from: frames[0]?.ts ?? 0,
    to: frames[frames.length - 1]?.ts ?? 0,
  };
}
```

> **Megjegyzés a `void ...` sorhoz:** az MVP Policy = HOLD, ezért az `applyRisk`/`buildFeatures`/`predict` még nem hívódik a belépő-úton. Hagyd benne az importot és a `void`-ot seam-ként; a P2 ML-policy ezekre épül. (Ha a linter tiltja a `void`-ot, töröld az import sort, és a P2-ben add vissza.)

- [ ] **Step 4: Futtasd — passzoljon**

Run: `pnpm test tests/lib/backtest/engine.test.ts`
Expected: PASS (3 teszt).

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/engine.ts tests/lib/backtest/engine.test.ts
git commit -m "feat(backtest): runBacktest hurok (planProfitCycle + gyertya-fill + metrikák)"
```

---

## Task 8: CLI + `/api/backtest` route

**Files:**
- Create: `scripts/backtest.ts`
- Modify: `src/app/api/backtest/route.ts`

**Interfaces:**
- Consumes: `loadHistory` (Task 3), `runBacktest` (Task 7), `COIN_UNIVERSE`.

- [ ] **Step 1: Írd meg a CLI-t**

`scripts/backtest.ts`:
```ts
/**
 * Backtest CLI: a teljes Binance-historyn futtatja a kód-profit-ciklust, és kiír egy
 * metrika-riportot. Futtatás: pnpm tsx scripts/backtest.ts [--pages N] [--slippage BPS]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  const { loadHistory } = await import("@/lib/backtest/data");
  const { runBacktest } = await import("@/lib/backtest/engine");
  const { COIN_UNIVERSE } = await import("@/lib/config");

  const arg = (name: string, def: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : def;
  };
  const pages = arg("pages", 5);
  const slippageBps = arg("slippage", 5);

  console.log(`Backtest: ${COIN_UNIVERSE.join(",")} | ${pages} klines-lap | slippage ${slippageBps}bps`);
  const history = await loadHistory([...COIN_UNIVERSE], pages);
  console.log(`Betöltve: ${history.length} órás keret`);

  const result = runBacktest(history, {
    symbols: [...COIN_UNIVERSE], initialCapitalUsd: 10000, feePct: 0.001, slippageBps,
  });

  const m = result.metrics;
  console.log("\n=== METRIKÁK ===");
  console.log(`Total return : ${(m.totalReturnPct * 100).toFixed(2)}%`);
  console.log(`Sharpe       : ${m.sharpe.toFixed(2)}`);
  console.log(`Max drawdown : ${(m.maxDrawdownPct * 100).toFixed(2)}%`);
  console.log(`Hit rate     : ${(m.hitRate * 100).toFixed(1)}%  (${m.tradesCount} lezárt trade)`);
  console.log(`Avg win/loss : +${(m.avgWinPct * 100).toFixed(2)}% / ${(m.avgLossPct * 100).toFixed(2)}%`);
  console.log(`Profit factor: ${m.profitFactor.toFixed(2)}`);
  console.log(`Exposure     : ${(m.exposurePct * 100).toFixed(1)}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Futtasd a CLI-t (valódi adat, smoke-test)**

Run: `pnpm tsx scripts/backtest.ts --pages 2`
Expected: kiír egy metrika-riportot (return, Sharpe, maxDD, hit-rate, trade-szám) hibára-omlás nélkül. (Hálózati hívás — Binance/alternative.me.)

- [ ] **Step 3: Írd át a route-ot**

`src/app/api/backtest/route.ts`:
```ts
import { NextResponse } from "next/server";
import { loadHistory } from "@/lib/backtest/data";
import { runBacktest } from "@/lib/backtest/engine";
import { COIN_UNIVERSE } from "@/lib/config";

// Hálózati fetch (Binance/F&G) + nehéz számítás — ne fusson build-időben.
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Backtest a valódi motorral: a kód-profit-ciklust futtatja a Binance-historyn,
 * gyertya-fill szimulációval, és metrikákat ad vissza. Lásd backtest spec.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pages = Number(url.searchParams.get("pages") ?? 3);
  const slippageBps = Number(url.searchParams.get("slippage") ?? 5);

  try {
    const history = await loadHistory([...COIN_UNIVERSE], pages);
    const result = runBacktest(history, {
      symbols: [...COIN_UNIVERSE], initialCapitalUsd: 10000, feePct: 0.001, slippageBps,
    });
    return NextResponse.json({
      ...result.metrics,
      framesCount: history.length,
      from: result.from,
      to: result.to,
    });
  } catch (e) {
    console.error("[api/backtest]", e);
    return NextResponse.json({ error: "backtest hiba", detail: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Verifikáció — teljes suite + tsc + build**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm build`
Expected: minden zöld (106 + új backtest-tesztek; tsc 0; build OK).

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest.ts src/app/api/backtest/route.ts
git commit -m "feat(backtest): CLI (scripts/backtest.ts) + /api/backtest valódi motorra átírva"
```

---

## Self-Review jegyzet (a szerző futtatta)

- **Spec-lefedettség:** §3 architektúra → Task 4–7; §5 fill-szabályok → Task 2 + Task 4; §6 metrikák → Task 1; §7 walk-forward → a `runBacktest(history, config)` dátum-szeletelhető (a hívó ad rész-historyt) — az MVP egy passt futtat, a split-wrapper P2; §8 tesztterv → minden task TDD + a parity Task 4/6-ban.
- **Determinizmus:** a `metrics`/`fill-sim`/`planProfitCycle`/`evaluatePosition` nem hív `Date.now`/IO-t (Global Constraints).
- **Type-konzisztencia:** `Candle`/`HistoryFrame`/`BacktestConfig`/`BacktestResult` (Task 1) végig egyezően használva; `PlannedOrder`/`ProfitCycleInput` (Task 5) a Task 6/7-ben azonosan; `simulateFill` `FillRequest.kind` ∈ {stop-loss,take-profit,market} a Task 7-ben helyesen mappelve (dca→market).
- **Nyitott:** az ML-policy (P2) seam-je a Task 7-ben `void`-dal jelölve; a walk-forward wrapper P2.

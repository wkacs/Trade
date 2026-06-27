# Stratégia‑tournament (P2) — dizájn spec

**Dátum:** 2026‑06‑27
**Státusz:** jóváhagyott dizájn (implementáció előtt)
**Kapcsolódó:** `docs/superpowers/specs/2026-06-27-backtest-engine-design.md` (a backtest, amire épül), `docs/superpowers/research/2026-06-26-profit-boost-external-repos.md` (P2 prioritás)

## 1. Cél és motiváció

A backtest szerint a kód‑profit‑ciklus ~83 napon enyhén negatív várható értékű (profit factor ~0.32, hit‑rate ~38%) — de a stratégia **paraméterei találgatáson alapulnak** (fix −5% stop, +15% TP, F&G≤25, 5% heti DCA), és a bot a **„Heti DCA‑keret elfogyott"** miatt HOLD‑ba fagy kis tőkén.

**Cél:** egy **variáns‑tournament**, amely a stratégiát paraméterezhetővé teszi, sok konfigurációt végigfuttat a backteszten **walk‑forward** módon, és **out‑of‑sample Sharpe** szerint rangsorol — így az **adat** választja ki a profitábilis beállítást, nem a tipp. Plusz a „Heti DCA‑keret" fagyás megszüntetése. Két ÚJ tunolható lever (ATR‑stop, belépő‑szűrő) bővíti a profit‑teret.

## 2. Scope

### Benne
- **`StrategyConfig`** — a stratégia minden tunolható paramétere egy objektumban; `DEFAULT_STRATEGY` = a mai konstansok (**parity**: a live viselkedés nem változik).
- `planProfitCycle` + a backtest‑motor **config‑vezérelt** (a hardcoded `RISK_LIMITS`/`PROFIT_CYCLE` helyett).
- **Két új lever** (config‑opció): **ATR‑alapú stop**, **belépő‑szűrő (trend)**.
- **„Heti DCA‑keret" fix:** a keret csak a DCA‑t fékezi, az AI BUY‑t nem; a keret tunolható.
- **Tournament CLI** (`scripts/tournament.ts`): grid → walk‑forward backtest configonként → **leaderboard** (report‑only).

### Kívül
- **Auto‑apply:** a nyerő configot a user **kézzel** veszi át a `DEFAULT_STRATEGY`-be (nincs automatikus élesítés).
- **LLM a tournamentben:** továbbra is kívül (Policy=HOLD, belépők a DCA‑ból; az MVP backtest‑motor öröksége).
- **Bayes/genetikus optimalizáció:** most rács‑sweep (grid); finomabb kereső csak ha a grid indokolja.

## 3. Architektúra

A stratégiát egy `StrategyConfig` vezérli. A `DEFAULT_STRATEGY` = a jelenlegi konstansok, így a **live `runTick` viselkedése bitre változatlan** (a 130 teszt zöld a guard); csak a backtest/tournament ad eltérő configokat.

| Komponens | Új/refaktor | Felelősség |
|---|---|---|
| `src/lib/strategy/config.ts` | **új** | `StrategyConfig` típus + `DEFAULT_STRATEGY` (a mai konstansokból). |
| `src/lib/strategy/atr.ts` | **új, tiszta** | `computeAtr(candles, period)` — Average True Range. |
| `src/lib/strategy/entry-filter.ts` | **új, tiszta** | `passesTrendFilter(closes, period)` — `close ≥ SMA(period)`. |
| `src/lib/strategy/position-actions.ts` | **refaktor** | `evaluatePosition` a stop‑árat ÉS a TP‑t/qtyFraction‑t configból kapja (stop a hívó által átadva, TP% + fraction configból). |
| `src/lib/strategy/fear-greedy.ts` | **refaktor** | `evaluateDca` a config küszöböit + a belépő‑szűrőt használja. |
| `src/lib/engine/profit-cycle.ts` | **refaktor** | `planProfitCycle(input, config)` — minden paraméter configból; ATR/filter bekötve; az `atrBySymbol` a hívótól. |
| `src/lib/risk/risk-manager.ts` | **refaktor** | a heti‑DCA‑keret kapu **kikerül az AI‑BUY ágból** (csak a DCA‑t fékezi a planner‑ben). |
| `src/lib/backtest/engine.ts` | **refaktor** | `runBacktest(history, btConfig, strategy)` — a `StrategyConfig`-ot átveszi; per‑frame ATR + SMA számítás és átadás. |
| `src/lib/backtest/walk-forward.ts` | **új, tiszta** | `splitHistory(frames, ratio)` + `rankConfigs(results, minTrades)` (OOS Sharpe). |
| `scripts/tournament.ts` | **új** | A grid generálása + walk‑forward futtatás + leaderboard. |
| `src/lib/engine/tick.ts` | **kis refaktor** | a live a `DEFAULT_STRATEGY`-t adja a planner‑nek + per‑symbol ATR/SMA‑t számol az OHLC‑ból (amit úgyis lekér). |

## 4. `StrategyConfig` (parity‑elv)

```ts
export interface StrategyConfig {
  stopMode: "fixed" | "atr";
  stopLossPct: number;          // fixed mód
  atrMult: number;              // atr mód: stop = entry − atrMult*ATR
  atrPeriod: number;
  takeProfitPct: number;
  takeProfitFraction: number;   // 0.5 = fél, 1.0 = teljes
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
```
`DEFAULT_STRATEGY` = `{ stopMode:"fixed", stopLossPct:0.05, atrMult:2, atrPeriod:14, takeProfitPct:0.15, takeProfitFraction:0.5, dcaFgThreshold:25, dcaBuyPct:0.02, dcaWeeklyBudgetPct:0.05, dcaMax24hDropPct:0.08, entryFilter:"off", entryFilterSmaPeriod:24, maxPositionPct:0.2, maxConcurrentPositions:3, dailyLossCircuitBreakerPct:0.03 }` — pontosan a mai viselkedés.

## 5. Az új leverek (pontos definíció)

**ATR‑stop** (`stopMode:"atr"`): `TR = max(high−low, |high−prevClose|, |low−prevClose|)`, `ATR = SMA(TR, atrPeriod)`. A pozíció stop‑ára belépéskor `entry − atrMult*ATR`; a trailing ratchet `max(prevStop, close − atrMult*ATR)`. Az ATR‑t a hívó (backtest‑motor / live tick) számolja a gyertya‑ablakból, és `atrBySymbol`‑ként adja a plannernek. `fixed` módban az ATR‑t figyelmen kívül hagyjuk (→ parity).

**Belépő‑szűrő** (`entryFilter:"trend"`): a DCA‑jelölt coin csak akkor jogosult, ha `close ≥ SMA(closes, entryFilterSmaPeriod)` (azaz nem szabadeséses lefelé trendben). `off` módban minden coin jogosult (→ parity). Konkrét átadás: a hívó (engine/tick) per‑symbol kiszámolja a `trendOk` flaget (`close ≥ SMA(N)`) és `trendOkBySymbol: Record<string, boolean>`-ként adja az `evaluateDca`-nak; `trend` módban a `trendOk=false` coinok kiesnek a jogosultsági listából, `off` módban a flag figyelmen kívül marad.

## 6. „Heti DCA‑keret" fix

A `risk-manager.applyRisk`‑ból **kikerül** a `weeklyBudgetRemainingUsd ≤ 0 → AI BUY HOLD` kapu. A heti keret ezután **csak a DCA‑t** fékezi (az `evaluateDca` már ellenőrzi). Így az AI saját, meggyőződéses BUY‑ját a max‑pozíció (20%) + max‑pozíciószám (3) + napi circuit breaker korlátozza, **nem a DCA‑keret** → megszűnik a „Heti DCA‑keret elfogyott" fagyás. A `dcaWeeklyBudgetPct` tunolható (5% / 10% / 20%).

## 7. Paraméter‑grid

| Paraméter | Értékkészlet |
|---|---|
| `stopMode` / `stopLossPct` (fixed) | 4% · 5% · 7% · 10% |
| `stopMode` / `atrMult` (atr) | 1.5× · 2× · 3× (period 14) |
| `takeProfitPct` | 10% · 15% · 25% · 40% |
| `takeProfitFraction` | 0.5 · 1.0 |
| `dcaFgThreshold` | 20 · 25 · 35 |
| `dcaBuyPct` | 2% · 4% |
| `dcaWeeklyBudgetPct` | 5% · 10% · 20% |
| `entryFilter` | off · trend(SMA 24h) · trend(SMA 72h) |

Teljes descartes ~pár ezer config. A backtest in‑memory, ms/futás, a history egyszer töltődik → másodpercek. A grid generátora a `stopMode`-ot kétfelé bontja (fixed: stopLossPct‑sweep; atr: atrMult‑sweep), hogy ne keletkezzen értelmetlen kombináció.

## 8. Walk‑forward + rangsor

- `splitHistory(frames, 0.7)` → in‑sample (első 70%) + out‑of‑sample (utolsó 30%).
- Minden config: `runBacktest` IS‑en ÉS OOS‑on.
- **Szűrő:** OOS lezárt‑trade ≥ `minTrades` (default 15) — kevés trade kiesik.
- **Rangsor:** OOS **Sharpe** szerint csökkenő. (Holtverseny: nagyobb OOS return.)
- A kiírás IS‑t és OOS‑t is mutatja → a nagy IS↔OOS szakadék overfit‑jelző.

## 9. Leaderboard (kimenet)

`pnpm tsx scripts/tournament.ts [--pages N] [--min-trades M] [--top K]`:
- **Baseline sor:** a `DEFAULT_STRATEGY` IS/OOS metrikái (ehhez viszonyítunk).
- **Top‑K config** (default 15): a config paraméterei + IS és OOS {return, Sharpe, maxDD, hit‑rate, profit‑factor, trade‑szám}.
- Ha egyetlen config sem veri a baseline OOS Sharpe‑ját → ezt **explicit kiírja** („a jelenlegi default a legjobb az OOS‑on" — fontos, hogy ne fessünk hamis nyerőt).
- **Report‑only:** nincs DB‑írás, nincs auto‑apply; a user a nyerő paramétereket kézzel viszi a `DEFAULT_STRATEGY`-be.

## 10. Tesztelési terv (TDD)

1. **Parity:** a `StrategyConfig` bevezetése + a `DEFAULT_STRATEGY` átkötés **viselkedés‑megőrző** → a **130 teszt zöld** a guard (a live a defaultot adja). A `planProfitCycle`/`evaluatePosition`/`evaluateDca` meglévő tesztjei a default configgal hívva változatlanok.
2. **`atr.ts`:** ismert gyertya‑sorozat → kézzel számolt ATR.
3. **`entry-filter.ts`:** ár az SMA felett → átmegy; alatta → kiesik.
4. **`risk-manager`:** AI BUY a `weeklyBudgetRemainingUsd=0` mellett **NEM** vált HOLD‑ra (új viselkedés); a DCA viszont igen.
5. **`walk-forward`:** `splitHistory` arányos vágás; `rankConfigs` az OOS Sharpe szerint rendez + min‑trade szűr.
6. **`engine` (atr/filter):** szintetikus history → atr‑stop tüzel a vol‑arányos szinten; a trend‑filter blokkolja a DCA‑t lefelé trendben.
7. **Determinizmus:** a tournament ugyanarra a history‑ra ugyanazt a leaderboardot adja.

## 11. Sikerkritérium

- `pnpm tsx scripts/tournament.ts` lefut a teljes historyn, és kiír egy leaderboardot (baseline + top‑K, IS/OOS).
- A 130 meglévő teszt + az új tesztek **mind zöldek**, `tsc` 0, `build` zöld.
- A „Heti DCA‑keret elfogyott" többé nem fagyasztja az AI BUY‑t (élő + teszt).
- A riport megválaszolja: van‑e olyan config, ami az **OOS‑on** veri a mai defaultot — és ha igen, melyik (a user ezt veszi át).

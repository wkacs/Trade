# Folyamat-átláthatóság a dashboardon (teljes tick-napló) — Design

> **Cél:** A dashboard tegye **átláthatóvá a bot teljes folyamatát** — ne csak az AI végső döntését mutassa, hanem (A) minden trade hajtóerejét, (B) a tickenkénti teljes döntési láncot, (C) a döntést tápláló tényleges bemeneteket, és (D) a hangolt stratégia szabályait.

**Dátum:** 2026-06-28
**Státusz:** jóváhagyott design → következő lépés: writing-plans
**Kapcsolódó:** [`2026-06-28-strategy-tuning-design.md`](./2026-06-28-strategy-tuning-design.md), [`2026-06-26-profit-cycle-design.md`](./2026-06-26-profit-cycle-design.md)

---

## 1. Probléma

A dashboard döntés-naplója (`DecisionsTimeline` → `DecisionCard` → `DecisionDetail`) az **AI döntését** mutatja (BUY/SELL/HOLD + érvelés + outcome). De a trade-eket most főleg a **kód-alapú profit-ciklus** hajtja (stop-loss / take-profit / DCA), ami az AI ELŐTT fut és `cycleActions`-t termel — **ez sehol nem látszik**, és nem is perzisztálódik (csak a tick-válaszban él). A `trades` táblának **nincs eredet-oszlopa** → egy trade-ről nem derül ki, hogy DCA / stop / take-profit / AI volt-e. Így amikor a bot DCA-zik vagy stoppol, a napló „HOLD"-ot mutat, a trade-napló meg „a semmiből" hoz egy trade-et.

A `DecisionDetail` is sekély (modell/mennyiség/bizonyosság), a tényleges bemeneteket (F&G, ML-jel, árak) nem mutatja — a kód-komment szerint is „későbbi bővítés".

## 2. A négy lencse → három építőkő

| Építőkő | Mit ad | Lencse |
|---|---|---|
| **1. Trade-eredet** (`origin` oszlop a `trades`-en) | minden trade önmagát magyarázza | A |
| **2. Tick-napló** (`tick_runs` tábla, 1 `TickProcess` JSON/tick) | a teljes lánc + a tényleges bemenetek, historikusan | B + C |
| **3. Statikus stratégia-magyarázó** (a hangolt config-ból) | a néző érti a bot szabályait | D |

## 3. Adatmodell

### 3.1 `trades.origin` oszlop
- `origin: varchar("origin", { length: 12 })` — értékek: `"dca" | "stop-loss" | "take-profit" | "ai" | "manual"`. **Nullable** (a régi sorok `null`-ok maradnak — nincs visszamenőleges kitöltés, YAGNI). A megjelenítés a `null`-t „—"-ként kezeli.

### 3.2 `tick_runs` tábla
```ts
export const tickRuns = pgTable("tick_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  tickId: varchar("tick_id", { length: 16 }).notNull(), // YYYY-MM-DD-HH
  process: jsonb("process").notNull(), // TickProcess (lásd 3.3)
});
```
~24 sor/nap → jelentéktelen tárhely. A `decisions.ref` mintát követi (`jsonb`).

### 3.3 `TickProcess` típus (a `process` JSON alakja)
Tiszta, tipizált alak (`src/lib/engine/tick-process.ts`):
```ts
export interface TickProcess {
  tickId: string;
  inputs: {
    prices: Record<string, number>;               // ár symbolonként
    fearGreed: { value: number; classification: string } | null;
    mlSignals: { symbol: string; direction1h: string; confidence: number }[];
  };
  cycleActions: { kind: "stop-loss" | "take-profit" | "dca"; side: "BUY" | "SELL"; symbol: string; qty?: number; amountUsd?: number }[];
  phase1: { shouldDecide: boolean; summary: string };
  phase2: { action: "BUY" | "SELL" | "HOLD"; symbol: string | null; amountPct: number; confidence: number; reasoning: string } | null; // null, ha phase-1 nem hívta
  decision: { action: "BUY" | "SELL" | "HOLD"; symbol: string | null; overridden: boolean; overrideReason: string | null };
  trades: { symbol: string; side: "BUY" | "SELL"; origin: string; amountUsd: number }[]; // a ticken végrehajtottak
}
```

## 4. Logika (well-bounded egységek)

### 4.1 `buildTickProcess(...)` — tiszta
- **Hol:** `src/lib/engine/tick-process.ts`.
- **Mit:** a `runTick` belső adataiból (events/prices/cycleActions/phase1/phase2/decision/trades) összeállítja a `TickProcess`-t. **Nincs IO/Date/Math.random** → determinisztikus, unit-tesztelhető.
- **Bemenet:** a meglévő `TickResult` mezői + a phase1/phase2 köztes eredmények (a `runTick` ezeket már kiszámolja).

### 4.2 `tradeOrigin(...)` — tiszta
- A trade forrás-ágából `origin`-t ad: cycleAction `kind` → `"dca"|"stop-loss"|"take-profit"`, AI-trade → `"ai"`. Az `applyTrade` hívások ezt kapják.

### 4.3 `insertTickRun(...)` — perzisztencia
- **Hol:** `src/lib/portfolio/accounting.ts` (a meglévő perzisztencia-modul mintája).
- **Best-effort:** `try/catch`-be zárva — a napló hibája SOHA ne buktassa a ticket (mint a többi best-effort hook).
- A `run-scheduled-tick`/`tick.ts` a tick végén hívja.

### 4.4 `applyTrade` kiegészítés
- Az `applyTrade` bemenete kap egy opcionális `origin` mezőt, amit beír a `trades.origin`-ba. A profit-ciklus ágak és az AI-ág a megfelelő értéket adják.

## 5. API

- **Új `/api/ticks`** (`force-dynamic`, `no-store`): a legutóbbi N `tick_runs` (default 20, max 100), `ts` szerint csökkenő. DB nélkül `{ ticks: [], note }`.
- **`/api/portfolio`** `recentTrades`: kiegészül az `origin` mezővel.
- **`/api/market`** `config`: kiegészül `entryFilter` + `takeProfitFraction`-nel (a magyarázó pontosságához).

## 6. Megjelenítés

- **`TradeBlotter`** — eredet-badge minden trade-en: `DCA` (accent) / `STOP` (down) / `TP` (up) / `AI` (dim) / `—` (null). Színkód a meglévő téma-tokenekből.
- **Új `TickInspector`** (`src/components/TickInspector.tsx`) — a `/api/ticks`-ből a legutóbbi tickek; a kiválasztott tick **teljes lánca** függőleges csővezetékként: `Inputok → ML → Profit-ciklus → Phase-1 → Phase-2 → Risk → Végrehajtás`. Lépésenként „tüzelt/kihagyva" állapot + a lényegi adat (pl. „Phase-1: HOLD — csendes piac", „Profit-ciklus: DCA BUY SOL $20"). A Dashboard rácsába kerül (a backtest/admin sor mellé vagy fölé).
- **`DecisionDetail`** — gazdagítva: a `decisions.ref` (már tárolt árak) + a tickhez kötött `tick_runs.inputs` (F&G, ML-jel) mono kulcs-érték sorokban. A tickId köti össze (`decisions.tickId` == `tick_runs.tickId`).
- **Új `StrategyPanel`** (`src/components/StrategyPanel.tsx`) — statikus magyarázó a `/api/market` configból: „Trend-szűrő BE (SMA24)", „Take-profit +10% → teljes zár", „DCA: F&G ≤20, 2%/vétel, heti 5% keret", „Stop-loss −5%", „Napi circuit breaker −3%". Rövid, emberi nyelvű szabály-lista.

## 7. Adatfolyam

```
tick (runner/Vercel) → runTick → {prices, cycleActions, phase1, phase2, decision, trades}
  → applyTrade(..., origin)            # trade az eredetével perzisztálva
  → buildTickProcess(...)              # tiszta összeállítás
  → insertTickRun(tickId, process)     # best-effort napló

dashboard:
  /api/ticks      → TickInspector (lánc)
  /api/portfolio  → TradeBlotter (origin badge) + DecisionDetail
  /api/market     → StrategyPanel (szabályok) + RiskPanel
```

## 8. Hibakezelés

- `insertTickRun` + `applyTrade(origin)` **best-effort** — DB-hiba nem buktatja a ticket (a tick fő útja változatlan).
- DB nélkül minden végpont graceful (üres lista + `note`), ahogy a meglévők.
- A régi `origin=null` trade-ek és a napló nélküli (régi) tickek a UI-ban „—"/„nincs napló" placeholder.

## 9. Tesztelés

- **TDD:** `buildTickProcess` (a TickResult-szerű bemenetből helyes TickProcess) + `tradeOrigin` (kind→origin leképezés) — tiszta, mock nélkül.
- `insertTickRun` perzisztencia mockolt DB-vel (a meglévő accounting-teszt minta).
- A UI-komponensek a projekt szokása szerint **vizuálisan verifikálva** (`pnpm dev` localhost / élő prod) — a tesztek lib-szintűek maradnak.
- **Teljes kapu:** `pnpm vitest run` zöld, `pnpm exec tsc --noEmit` 0, `pnpm build` zöld.

## 10. Migráció

⚠️ A memória szerint ennél a projektnél **egy Neon DB** (`.env.local` == prod, `ep-super-meadow`). A migráció **additív** (új `tick_runs` tábla + nullable `trades.origin`) → visszafelé kompatibilis, biztonságos, de **élő adatot érint**. `pnpm db:generate` → `pnpm db:migrate` a runner/Vercel által használt DB-re. A régi kód a régi DB-vel is fut (additív séma).

## 11. Hatókörön kívül (YAGNI)

- A régi trade-sorok `origin`-jának visszamenőleges kitöltése (csak előre).
- A nyers hír/whale szövegek tárolása (csak a strukturált `inputs` pillanatkép).
- Komponens-szintű automata tesztek (vizuális verifikáció a projekt mintája szerint).
- Új téma/redesign — a meglévő „trading terminál" tokenekbe illeszkedünk.

## 12. Siker-kritérium

- Minden új trade a naplóban a **hajtóerejével** látszik (DCA/STOP/TP/AI).
- A `TickInspector`-ban bármely (napló óta keletkezett) tick **teljes lánca** visszanézhető.
- A `DecisionDetail` a tényleges bemeneteket (F&G, ML, árak) mutatja.
- A `StrategyPanel` érthetően leírja a hangolt szabályokat.
- Teljes kapu (vitest + tsc + build) zöld; a migráció lefutott; prod-on vizuálisan verifikálva.

# Stratégia-hangolás „Gyors győzelem" (Approach A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live `DEFAULT_STRATEGY`-t az egyértelműen negatív EV-ből egy walk-forward-on mindkét ablakban igazolt, kis pozitív EV-be vinni — overfit-rezisztens tournament-kiválasztással, a nyertes config átvételével (trend-szűrő BE, TP≈10%, FG≈20), paper módban.

**Architecture:** Három lépés: (1) a `rankConfigs`-ot overfit-rezisztens „robust" móddal bővítjük (IS>0 ÉS OOS>0, `min(IS,OOS)` Sharpe rangsor); (2) `--robust` CLI-kapcsolóval újrafuttatjuk a tournamentet több adaton, és **rögzítjük a nyertes configot**; (3) a nyertest átvesszük a forrás-igazságba (`config.ts` `PROFIT_CYCLE` + `strategy/config.ts` `DEFAULT_STRATEGY`), a parity-teszteket átfordítjuk, és a teljes kaput zöldre hozzuk. A live tick már importálja a `DEFAULT_STRATEGY`-t és kész az ATR/trend útvonal — csak a kapcsoló.

**Tech Stack:** TypeScript, Vitest (TDD), tsx (CLI). Épít a meglévő backtest/tournament-infrára (`src/lib/backtest/*`, `scripts/tournament.ts`).

## Global Constraints

- **Paper marad:** `TRADING_MODE` nem változik; nincs live-váltás.
- **Report-only tournament:** nincs DB-írás, nincs auto-apply (a nyertest kézzel vesszük át).
- **Teljes kapu minden átvétel után:** `pnpm vitest run` zöld, `pnpm exec tsc --noEmit` 0 hiba, `pnpm build` zöld.
- **Magyar kommentek, `@/`-alias importok, a meglévő teszt-minta** (`tests/lib/...` tükrözi `src/lib/...`).
- **A `rankConfigs` tiszta marad:** nincs `Date.now`/`Math.random`/IO.
- **Lockstep:** a `PROFIT_CYCLE` és a `DEFAULT_STRATEGY` egyező mezőit együtt módosítjuk (a `config.test.ts` relációs állításai ezt kikényszerítik).
- **A nyertes config értékei a Task 2 re-runjából jönnek** — a Task 3 példaértékei (`#3`-szerű: TP 0.10 / FG 20 / fraction 1.0 / `entryFilter:"trend"` / stop fix 5%) helyettesítendők a tényleges nyertessel.

---

## Task 1: `rankConfigs` overfit-rezisztens „robust" mód

**Files:**
- Modify: `src/lib/backtest/walk-forward.ts:19-28` (a `rankConfigs` függvény)
- Test: `tests/lib/backtest/walk-forward.test.ts` (új teszteset hozzáadása)

**Interfaces:**
- Consumes: `RankedConfig<C>` (létező: `{ config: C; is: BacktestResult; oos: BacktestResult }`), `BacktestResult.metrics.{sharpe, tradesCount, totalReturnPct}`.
- Produces: `rankConfigs<C>(items: RankedConfig<C>[], minTrades: number, opts?: { robust?: boolean }): RankedConfig<C>[]` — `opts` elhagyásakor a régi (OOS-only) viselkedés; `{ robust: true }` esetén csak az IS>0 ÉS OOS>0 configok, `min(IS,OOS)` Sharpe szerint rangsorolva.

- [ ] **Step 1: Írd meg a bukó tesztet**

Add hozzá a `tests/lib/backtest/walk-forward.test.ts` `describe("walk-forward", ...)` blokkjához (a `res(sharpe, trades, ret)` helper már létezik a fájlban):

```ts
  it("rankConfigs robust módban kizárja a negatív-IS configot és min(IS,OOS) szerint rangsorol", () => {
    const items = [
      { config: "lucky", is: res(-0.7, 30), oos: res(3.2, 30) }, // negatív IS → overfit-gyanú → kiesik
      { config: "solid", is: res(1.0, 30), oos: res(2.3, 30) }, // min(IS,OOS) = 1.0
      { config: "robust", is: res(1.8, 30), oos: res(1.5, 30) }, // min(IS,OOS) = 1.5 → első
    ];
    const ranked = rankConfigs(items, 15, { robust: true });
    expect(ranked.map((r) => r.config)).toEqual(["robust", "solid"]);
  });
```

- [ ] **Step 2: Futtasd a tesztet, ellenőrizd hogy BUKIK**

Run: `pnpm vitest run tests/lib/backtest/walk-forward.test.ts`
Expected: FAIL — a `lucky` még benne van és/vagy rossz a sorrend (a jelenlegi `rankConfigs` csak OOS Sharpe szerint rendez, így a `lucky` lenne az első és nem esik ki).

- [ ] **Step 3: Implementáld a robust ágat**

Cseréld le a `rankConfigs` függvényt (`src/lib/backtest/walk-forward.ts`):

```ts
/**
 * Rangsorol a configok között; min-trade kapu az OOS-on.
 * - alapból: OOS Sharpe szerint (csökkenő), holtverseny → OOS return.
 * - robust módban (overfit-rezisztens): csak IS>0 ÉS OOS>0 Sharpe, rangsor a
 *   gyengébbik (min) Sharpe szerint — így a szerencsés (negatív-IS / nyerő-OOS)
 *   configok kiesnek, és a mindkét ablakban tartó él kerül előre.
 */
export function rankConfigs<C>(
  items: RankedConfig<C>[],
  minTrades: number,
  opts: { robust?: boolean } = {},
): RankedConfig<C>[] {
  const gated = items.filter((x) => x.oos.metrics.tradesCount >= minTrades);
  if (!opts.robust) {
    return gated.sort(
      (a, b) =>
        b.oos.metrics.sharpe - a.oos.metrics.sharpe ||
        b.oos.metrics.totalReturnPct - a.oos.metrics.totalReturnPct,
    );
  }
  const robustScore = (r: RankedConfig<C>) => Math.min(r.is.metrics.sharpe, r.oos.metrics.sharpe);
  return gated
    .filter((x) => x.is.metrics.sharpe > 0 && x.oos.metrics.sharpe > 0)
    .sort(
      (a, b) =>
        robustScore(b) - robustScore(a) ||
        b.oos.metrics.totalReturnPct - a.oos.metrics.totalReturnPct,
    );
}
```

- [ ] **Step 4: Futtasd a tesztet, ellenőrizd hogy ÁTMEGY**

Run: `pnpm vitest run tests/lib/backtest/walk-forward.test.ts`
Expected: PASS — mindkét eset (a régi „rankConfigs az OOS Sharpe szerint…" és az új robust) zöld. A régi teszt 2 argumentummal hív → `opts` default `{}` → változatlan viselkedés.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/walk-forward.ts tests/lib/backtest/walk-forward.test.ts
git commit -m "feat(walk-forward): rankConfigs robust mód (IS>0 ÉS OOS>0, min(IS,OOS) rangsor)"
```

---

## Task 2: `--robust` CLI-kapcsoló + re-run + a nyertes rögzítése

**Files:**
- Modify: `scripts/tournament.ts:21-27` (arg-olvasó + `rankConfigs` hívás `92`. sor körül)

**Interfaces:**
- Consumes: a Task 1 `rankConfigs(items, minTrades, { robust })` szignatúrája.
- Produces: a konzol kiírja a robust nyertest; a **nyertes config a plan-be kerül rögzítésre** (a Task 3 ezt veszi át).

- [ ] **Step 1: Adj `--robust` kapcsolót a tournament CLI-hez**

A `scripts/tournament.ts`-ben az arg-olvasó (`21-27`. sor) után add hozzá:

```ts
  const robust = process.argv.includes("--robust");
```

Cseréld a rangsor-hívást (jelenleg `const ranked = rankConfigs(items, minTrades);`):

```ts
  const ranked = rankConfigs(items, minTrades, { robust });
  console.log(
    `\n=== TOP ${top} (${robust ? "ROBUST: IS>0 ÉS OOS>0, min(IS,OOS) Sharpe" : "OOS Sharpe"}; ${ranked.length}/${grid.length} config a kapun túl) ===`,
  );
```

(A meglévő `console.log("\n=== TOP ${top} (OOS Sharpe; …")` sort ez a sor váltja ki — töröld a régit, ne duplázódjon.)

- [ ] **Step 2: tsc + a régi (nem-robust) futás smoke-ellenőrzése**

Run: `pnpm exec tsc --noEmit`
Expected: 0 hiba.

- [ ] **Step 3: Futtasd a robust re-runt több adaton**

Run (hosszú lehet — adj neki bő időt vagy futtasd háttérben logfájlba):
```bash
pnpm tsx scripts/tournament.ts --pages 8 --min-trades 8 --robust --top 12
```
Expected: kiírja a BASELINE-t (mai default, várhatóan negatív OOS) és a robust TOP-listát. A robust kritérium miatt **minden listázott config IS>0 ÉS OOS>0**. Ha a lista üres → ld. Step 5.

- [ ] **Step 4: Rögzítsd a nyertest a planben**

Írd be ide a Step 3 `#1` robust configját (a `desc(...)` sorból kiolvasva).

**RÖGZÍTETT NYERTES (re-run: `--pages 8 --min-trades 8 --robust`, 8000h ≈ 333 nap, IS 5600 / OOS 2400; 111/3024 config jutott át a robust kapun):**

```
#1  stop fix5% · TP 10%/1 · FG20 · dca 2%/5% · trend24
  stopMode ........... "fixed"
  stopLossPct ........ 0.05     (változatlan)
  takeProfitPct ...... 0.10     (15% → 10%)
  takeProfitFraction . 1.0      (0.5 → 1.0, teljes pozíció zárás)
  dcaFgThreshold ..... 20       (25 → 20)
  dcaBuyPct .......... 0.02     (változatlan)
  dcaWeeklyBudgetPct . 0.05     (változatlan — NINCS kockázat-növelés)
  entryFilter ........ "trend"  (off → trend)  ← a gyökér-fix
  entryFilterSmaPeriod 24       (változatlan)
  IS:  Sharpe 1.93 · PF 2.50 · ret 1.8% · maxDD 0.7% · 25 trade
  OOS: Sharpe 2.60 · PF 3.64 · ret 1.4% · maxDD 0.5% · 9 trade
  BASELINE (mai default): IS Sharpe -0.11 / OOS Sharpe -2.31 → a nyertes erősen veri.
```

✅ **Döntési pont feloldva:** a #1 nyertes `dcaWeeklyBudgetPct`-je **0.05 (a mostani érték)**, nem 0.20 — tehát nincs heti-keret emelés, nincs kockázat-növelés. A #2 (dca 4%/10%) magasabb hozamú, de dupla pozícióméret + dupla heti-keret + nagyobb drawdown → elvetve az alacsony-drawdown preferencia miatt. A #1 a legjobb `min(IS,OOS)` Sharpe és a legalacsonyabb maxDD.

- [ ] **Step 5: Ha a robust kapun NEM jut át config**

Akkor a tanulság: paraméter-hangolással nem nyerhető megbízható él ezen a griden/adaton. **NE** módosítsd a `DEFAULT_STRATEGY`-t. Állítsd le a plant itt, és jelezd: a következő lépés az **Approach B** (strukturális belépő-javítás, külön spec/plan). A Task 1–2 (robust mód + CLI) így is értékes és commitolható marad.

- [ ] **Step 6: Commit**

```bash
git add scripts/tournament.ts docs/superpowers/plans/2026-06-28-strategy-tuning.md
git commit -m "feat(tournament): --robust kapcsoló + a re-run nyertesének rögzítése"
```

---

## Task 3: A nyertes átvétele a live stratégiába + parity-tesztek átfordítása

**Files:**
- Modify: `src/lib/config.ts:27-42` (`PROFIT_CYCLE`)
- Modify: `src/lib/strategy/config.ts` (`DEFAULT_STRATEGY` — a `takeProfitPct`/`dcaFgThreshold`/`takeProfitFraction`/`entryFilter` mezők)
- Modify: `tests/lib/strategy/config.test.ts` (a hardcode-olt 3. teszt + új regressziós teszt)

**Interfaces:**
- Consumes: a Task 2-ben rögzített nyertes config értékei.
- Produces: a live `DEFAULT_STRATEGY` a hangolt értékekkel (`entryFilter: "trend"`); a tick automatikusan ezzel fut.

> A lenti kód a **`#3`-szerű példányt** mutatja (TP 0.10 / fraction 1.0 / FG 20 / `entryFilter:"trend"` / stop fix 5% / dcaWeekly 0.05). **Helyettesítsd a Task 2 tényleges nyertesével**, ha eltér.

- [ ] **Step 1: Írd meg a bukó regressziós tesztet**

A `tests/lib/strategy/config.test.ts` `describe("DEFAULT_STRATEGY", ...)` blokkjába add (a meglévő 3. „alapból a mai módok…" teszt MELLÉ — azt a Step 3 cseréli):

```ts
  it("a hangolt live stratégia: trend-szűrő BE + a hangolt TP/FG (Approach A)", () => {
    expect(DEFAULT_STRATEGY.entryFilter).toBe("trend");
    expect(DEFAULT_STRATEGY.takeProfitPct).toBe(0.1); // a Task 2 nyertese szerint
    expect(DEFAULT_STRATEGY.takeProfitFraction).toBe(1.0);
    expect(DEFAULT_STRATEGY.dcaFgThreshold).toBe(20);
  });
```

- [ ] **Step 2: Futtasd, ellenőrizd hogy BUKIK**

Run: `pnpm vitest run tests/lib/strategy/config.test.ts`
Expected: FAIL — a jelenlegi `DEFAULT_STRATEGY` `entryFilter:"off"`, `takeProfitPct:0.15`, `takeProfitFraction:0.5`, `dcaFgThreshold:25`. Plusz a régi 3. teszt (`entryFilter` `"off"`) is bukhat majd a Step 3 után — ezért azt is frissítjük.

- [ ] **Step 3: Vedd át a nyertest + fordítsd át a régi parity-tesztet**

(a) `src/lib/config.ts` — `PROFIT_CYCLE`:

```ts
export const PROFIT_CYCLE = {
  /** Take-profit: ha a pozíció ennyit ért el (+10%), eladja a teljes pozíciót. */
  takeProfitPct: 0.1,
  /** DCA: Fear & Greed index ezen küszöb (≤20) alatt halmoz. */
  dcaFgThreshold: 20,
  /** DCA: heti költési keret a tőke hányadaként. */
  dcaWeeklyBudgetPct: 0.05,
  /** DCA: egy vétel mérete a tőke hányadaként (2%). */
  dcaBuyPct: 0.02,
  /**
   * DCA: ha egy coin 24h esése (abszolút értékben) ezt meghaladja (>8%), az
   * „szabaduló zuhanás" — nem veszünk bele. Lásd spec §7.
   */
  dcaMax24hDropPct: 0.08,
};
```

(b) `src/lib/strategy/config.ts` — `DEFAULT_STRATEGY` érintett mezői (a többi változatlan):

```ts
  takeProfitPct: 0.1,
  takeProfitFraction: 1.0,
  dcaFgThreshold: 20,
  ...
  entryFilter: "trend",
```

(c) `tests/lib/strategy/config.test.ts` — a régi 3. teszt átfordítása az új módokra:

```ts
  it("alapból a hangolt módok: fixed stop, trend-szűrő BE, teljes take-profit", () => {
    expect(DEFAULT_STRATEGY.stopMode).toBe("fixed");
    expect(DEFAULT_STRATEGY.entryFilter).toBe("trend");
    expect(DEFAULT_STRATEGY.takeProfitFraction).toBe(1.0);
  });
```

- [ ] **Step 4: Futtasd a config-teszteket, ellenőrizd hogy ÁTMENNEK**

Run: `pnpm vitest run tests/lib/strategy/config.test.ts`
Expected: PASS — a relációs tesztek (`DEFAULT_STRATEGY.x === PROFIT_CYCLE.x`) a lockstep miatt zöldek; az átfordított 3. teszt és az új regressziós teszt zöld.

- [ ] **Step 5: Futtasd a TELJES suite-ot, javítsd az esetleges érték-pinnelt töréseket**

Run: `pnpm vitest run`
Expected: PASS (147 teszt — 146 meglévő + 1 új regressziós; a `config.test.ts` 3. tesztje cserélődött, nem nőtt).

Megjegyzés a várt állapotról (előzetes elemzés alapján zöldnek kell lenniük, ne módosítsd őket vakon):
- `profit-cycle.test.ts`: az üres `trendOkBySymbol` map `undefined !== false` → átmegy (a szűrő csak az explicit `false`-t ejti, ld. `fear-greedy.ts:62`); FG=20 a 20-as küszöbön `>`-operátorral átmegy (`fear-greedy.ts:47`). **Zöld.**
- `engine.test.ts`: a szintetikus belépő-frame-en az ár lapos/emelkedő → `passesTrendFilter` true; a TP-assertek lazák (`>0`, `≥1`). **Zöld.**

Ha mégis bukik egy érték-pinnelt teszt: a törő assertet igazítsd a **mechanizmushoz** (ne a véletlen számhoz) — pl. ha egy teszt a régi `0.15` TP-re számít, állítsd át az új nyertes-értékre vagy injektálj explicit configot.

- [ ] **Step 6: Commit**

```bash
git add src/lib/config.ts src/lib/strategy/config.ts tests/lib/strategy/config.test.ts
git commit -m "feat(strategy): hangolt DEFAULT_STRATEGY átvétele (trend-szűrő BE, TP10%, FG20)"
```

---

## Task 4: Teljes verifikáció + zárás

**Files:** nincs új; csak kapu-futtatás és commit.

- [ ] **Step 1: Teszt-kapu**

Run: `pnpm vitest run`
Expected: PASS — minden teszt (≈147) zöld.

- [ ] **Step 2: Típus-kapu**

Run: `pnpm exec tsc --noEmit`
Expected: 0 hiba.

- [ ] **Step 3: Build-kapu**

Run: `pnpm build`
Expected: `next build` zöld (Compiled successfully).

- [ ] **Step 4: Záró commit (ha maradt nem-commitolt változás)**

```bash
git add -A
git commit -m "chore: stratégia-hangolás (Approach A) — teljes kapu zöld" || echo "nincs változás"
```

- [ ] **Step 5: Élesítés + mérés (kézi, a felhasználó lépése)**

- A felhasználó **kézzel pushol** master-re (a memória szerint így szokta). Push után a GitHub óránkénti runner a következő `:07`-es futáskor **automatikusan** a hangolt `DEFAULT_STRATEGY`-vel tickel — nincs új secret, nincs infra-változás.
- **Paper-mérés 3–5 nap:** `https://trade-beryl-six.vercel.app/api/portfolio` + `/api/market` figyelése; a realized hozam összevetése a tournament-várakozással. A `TRADING_MODE` marad `paper`. A siker-küszöb: „megáll a vérzés + enyhe pozitív EV alacsony drawdownnal", nem nagy profit.

---

## Self-Review (kitöltve)

**Spec-lefedettség:**
- Spec §3.1 (tournament-keményítés) → Task 1 + Task 2 Step 1. ✓
- Spec §3.2 (nyertes rögzítése + átvétel) → Task 2 Step 3-4 + Task 3 Step 3. ✓
- Spec §3.3 (tesztek átfordítása + regressziós teszt) → Task 3 Step 1,3. ✓
- Spec §5 (kockázatok: üres robust-kapu, dcaWeekly döntés) → Task 2 Step 4-5. ✓
- Spec §6 (TDD + teljes kapu) → Task 1/3 TDD, Task 4 kapuk. ✓
- Spec §7 (élesítés + paper-mérés) → Task 4 Step 5. ✓
- Spec §8 (siker-kritérium) → Task 2 (robust nyertes vagy „Approach B" tanulság) + Task 4. ✓

**Placeholder-ellenőrzés:** a Task 3 értékei a Task 2 re-runjából jönnek; ez **explicit, parametrikus lépés worked-példával**, nem placeholder. A „NYERTES (kitöltendő)" blokk a futás kimenetét rögzíti — adatforrás megjelölve. ✓

**Típus-konzisztencia:** `rankConfigs(items, minTrades, opts?)` egységesen Task 1-ben definiálva és Task 2-ben fogyasztva; `RankedConfig`/`BacktestResult.metrics` mezőnevek a `types.ts`-ből. ✓

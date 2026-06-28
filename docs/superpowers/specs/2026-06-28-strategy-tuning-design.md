# Stratégia-hangolás: „Gyors győzelem" (Approach A) — Design

> **Cél:** A live stratégiát az egyértelműen negatív EV-ből egy walk-forward-on **mindkét ablakban** igazolt, kis pozitív EV-be vinni — overfit-rezisztens kiválasztással, nem egy szerencsés config bemásolásával.

**Dátum:** 2026-06-28
**Státusz:** jóváhagyott design → következő lépés: writing-plans
**Kapcsolódó:** [`2026-06-27-strategy-tournament-design.md`](./2026-06-27-strategy-tournament-design.md) (a tournament-infra, amire ez épít), [`2026-06-27-backtest-engine-design.md`](./2026-06-27-backtest-engine-design.md)

---

## 1. Probléma és bizonyíték

A felhasználó megfigyelése: a bot **összesített P&L-je piros**. A tournament (4000h ≈ 166 nap, 3024 config, walk-forward 70/30) ezt igazolja — a **jelenlegi élő `DEFAULT_STRATEGY` mindkét ablakban veszteséges:**

| Ablak | hozam | Sharpe | profit factor | trade |
|---|---|---|---|---|
| IS (betanító) | −0.6% | −0.92 | 0.74 | 17 |
| OOS (teszt) | −1.1% | −3.66 | 0.29 | 6 |

**Gyökérok:** a `DEFAULT_STRATEGY.entryFilter` jelenleg `"off"` → a bot **trend-irány figyelmen kívül hagyásával DCA-zik bele a félelembe** (zuhanó kést fog). A tournament **minden** top-configjában a trend-szűrő **be van kapcsolva**.

**Robusztus minta** (a top-listában újra meg újra visszatérő, nem egyetlen config):
- ✅ Trend-szűrő **BE** (`trend`, SMA 24)
- ✅ Take-profit **10%** (a mostani 15% helyett) — hamarabb zsebeli a nyereséget
- ✅ Fear-kapu **FG20** (a 25 helyett) — csak mélyebb félelemnél vásárol

A legkonzervatívabb hiteles jelölt a **#3 config** (`stop fix5% · TP 10%/teljes · FG20 · trend24`): az **egyetlen** a top-5-ben, ami **mindkét** ablakban pozitív (IS Sharpe +1.03, OOS +2.27, PF 1.68/2.51).

### Statisztikai óvatosság (miért nem másoljuk be vakon a #1-et)

- A #1 config OOS-on +3.24 Sharpe, **de IS-en −0.67** → ez **OOS-szerencse, nem él**. 3024 configból néhány véletlenül „szépen néz ki" (multiple-comparison).
- A hozamok **aprók** (+1–2% ~50 nap alatt), a trade-szám kicsi (5–15 OOS) → **alacsony statisztikai bizonyosság**.
- **Reális cél:** nem „pénznyomda", hanem **„ne vérezzen + kicsi, kontrollált pozitív EV alacsony drawdownnal"**. A robusztus jelölt pont ez: ~+1.2% / 1.2% maxDD.

---

## 2. Hatókör

**Benne van:**
1. A tournament kiválasztásának overfit-rezisztenssé tétele (`--robust` mód).
2. Újrafuttatás több történelmi adaton → a *valódi* nyertes config rögzítése.
3. A nyertes config átvétele a live `DEFAULT_STRATEGY`-be.
4. A teszt-suite őszintén tartása (a parity-guard szerepe átfordul).
5. Verifikáció + élesítés (push → GitHub runner) + paper-mérési jegyzet.

**Hatókörön kívül (YAGNI):**
- 10-perces cadence / „csak-kockázat" gyors hurok (a belépő-jel órás gyertyához kötött → alacsony tét a profitra; külön döntés, későbbre).
- Strukturális regime/RSI belépő-javítás (= **Approach B**, későbbi increment).
- Live trading (marad `paper`).

---

## 3. Komponensek és változó fájlok

### 3.1 Tournament-keményítés (overfit-rezisztens kiválasztás)

A mostani rangsor **csak OOS Sharpe** szerint rendez → kiválasztja a szerencsés (negatív-IS / szerencsés-OOS) configokat.

- **`src/lib/backtest/walk-forward.ts`** — `rankConfigs` kap egy opcionális paramétert: `robust` mód.
  - Követelmény: **IS Sharpe > 0 ÉS OOS Sharpe > 0** (a min-trade kapun túl).
  - Rangsor-kulcs: **`min(IS Sharpe, OOS Sharpe)`** (a gyengébbik ablakot maximalizáljuk) az OOS-only helyett.
  - A meglévő (nem-robust) viselkedés **alapból változatlan** marad → a P2 walk-forward tesztek zöldek; a robust mód opt-in.
- **`scripts/tournament.ts`** — új **`--robust`** CLI-kapcsoló, ami a `rankConfigs`-ot robust módban hívja, és a kiírásban jelzi a robust kritériumot.

**Interfész (well-bounded):** `rankConfigs(items, minTrades, opts?: { robust?: boolean })` — tiszta függvény, nincs IO/Date/Math.random. Egységtesztelhető önállóan.

### 3.2 A robusztus config rögzítése + átvétele

- Re-run: `pnpm tsx scripts/tournament.ts --pages 10 --min-trades 8 --robust --top 12` (a teljes ~416 nap).
- A **#1 robusztus configot** vesszük át (várhatóan ~#3: trend BE / TP10%/teljes / FG20 / stop fix5%). **A pontos `dcaWeeklyBudgetPct` és stop-mód a re-run kimenetéből jön, nem tippből** — ez a re-run a plan egyik lépése, nem a designban előre rögzített szám.
- Forrás-igazság frissítése (lockstep, mert a `config.test.ts` kikényszeríti a szinkront):
  - **`src/lib/config.ts`** — `PROFIT_CYCLE.takeProfitPct` (15%→10%), `dcaFgThreshold` (25→20), és ha a nyertes úgy hozza, `dcaWeeklyBudgetPct`.
  - **`src/lib/strategy/config.ts`** — `DEFAULT_STRATEGY` tükör + **`entryFilter: "trend"`** + `takeProfitFraction` (0.5→1.0 ha a nyertes teljes TP).
- **A live tick (`src/lib/engine/tick.ts`) már importálja a `DEFAULT_STRATEGY`-t, és az ATR + `passesTrendFilter` útvonal be van drótozva** (ma csak `entryFilter:"off"` gátolja, lásd a 271. sor kommentjét) → a szűrő bekapcsolása **aktiválja a kész útvonalat, új plumbing nélkül.**

### 3.3 Tesztek (a parity-guard szerepe átfordul)

A parity-tesztek eddig azt védték, hogy „a config-vezérlés **nem** változtatott a viselkedésen". Most **szándékosan** változtatunk:
- **`tests/lib/strategy/config.test.ts`** — a hardcode-olt érték-állítások frissítése az új konstansokra (`entryFilter` `"off"`→`"trend"`, `takeProfitFraction` 0.5→új). A relációs állítások (`DEFAULT_STRATEGY.x === PROFIT_CYCLE.x`) **változatlanul maradnak** → továbbra is őrzik a config.ts ↔ DEFAULT szinkront.
- **Új regressziós teszt**: „a live `DEFAULT_STRATEGY` aktívan futtatja a trend-szűrőt + a hangolt TP/FG-t" → egy véletlen visszaállást (szűrő ki, vagy régi TP) elkap.
- A mechanizmus-tesztek (`position-actions`, `fear-greedy` — explicit configot **injektálnak** a függvénynek) **érintetlenek**.
- A `tick.test.ts` / `profit-cycle.test.ts` / `engine.test.ts` / `phase2-decide.test.ts`: a plan futtatja a teljes suite-ot és **az érték-pinnelt töréseket pontszerűen javítja** (várhatóan kevés; a legtöbb explicit configot ad).

---

## 4. Adatfolyam (változatlan, csak a paraméterek mások)

```
óránkénti GitHub runner → run-scheduled-tick → tick.ts
  → collectors (1h klines) → computeAtr + passesTrendFilter(DEFAULT_STRATEGY)
  → planProfitCycle(input, DEFAULT_STRATEGY)   # most: trend-szűrt belépő, TP10%, FG20
  → Risk Manager → Execution (PaperBroker)
```

A re-run/tournament adatfolyama (offline, report-only): `loadHistory → splitHistory(0.7) → runBacktest(IS) + runBacktest(OOS) → rankConfigs(robust)`. **Nincs DB-írás, nincs auto-apply.**

---

## 5. Hibakezelés / kockázatok

- **Overfit-kockázat** → a `--robust` mód (IS>0 ÉS OOS>0, min(IS,OOS) rangsor) + több adat ezt célozza. Ha a robust kapun **egyetlen config sem jut át**, az is eredmény: marad a default, és a tanulság, hogy paraméter-hangolással nem nyerhető él → Approach B-re lépünk (külön session).
- **Kis él / nagy zaj** → a spec rögzíti: 3–5 nap **paper-mérés** push után, realized vs. backtest összevetés. Nincs live-váltás.
- **Teszt-törés a hangolásnál** → a `config.test.ts` szinkron-állításai épp ezt teszik láthatóvá és kezelhetővé (lockstep frissítés).
- **dcaWeekly emelés kockázata** → ha a nyertes 20% heti keretet hoz (4× a mostani), a plan-ben **explicit döntési pont**: átvesszük-e, vagy óvatosabb értéket választunk a robusztus jelöltek közül (alacsonyabb drawdown preferencia).

---

## 6. Tesztelési stratégia

- **TDD a tournament-keményítéshez:** `rankConfigs` robust mód unit-teszt (negatív-IS config kiesik; `min(IS,OOS)` rangsor helyes) **a `walk-forward` implementáció módosítása előtt**.
- **Regressziós teszt** a live stratégia hangolt voltára (3.3).
- **Teljes kapu élesítés előtt:** `pnpm vitest run` zöld, `pnpm exec tsc --noEmit` 0, `pnpm build` zöld.
- A re-run **nem** automatizált teszt (külső Binance-adat), hanem a plan egy manuális, dokumentált lépése a kimenet logolásával.

---

## 7. Élesítés és mérés

1. `vitest` + `tsc` + `build` zöld.
2. Commit + **push master** → a GitHub óránkénti runner a következő `:07`-es futáskor **automatikusan** az új `DEFAULT_STRATEGY`-vel tickel (nulla infra-változás, nincs új secret).
3. **Paper-mérés 3–5 nap**: `/api/portfolio` + `/api/market` figyelése, a tournament-várakozással összevetve. Az él kicsi és bizonytalan — a siker = „megáll a vérzés + enyhe pozitív EV alacsony drawdownnal", nem nagy profit.
4. A `TRADING_MODE` **marad `paper`**.

---

## 8. Siker-kritérium

- A keményített tournament ad egy **mindkét ablakban pozitív** (IS>0 és OOS>0) nyertes configot, ami **veri a default OOS-ját** — vagy egyértelmű „nincs ilyen → Approach B" tanulság.
- A teljes suite + tsc + build **zöld** az átvétel után.
- A live bot a push után a hangolt stratégiával tickel (verifikálva a prod API-n).
- Dokumentált paper-mérési ablak nyitva a realized vs. backtest összevetésére.

# Trading-bot fejlesztési roadmap: profit-boost → gyorsítás → élesre — Design

> **Áttekintés:** A felhasználó kérése (gyorsabb kereskedés + több profit trade-enként) **három fázisra** bomlik. A 2026-06-28-i backtestek megcáfolták a szűk-TP scalpet (a díjakon bukik, −0,25%/trade), ezért a roadmap a **díjakat túlélő** emelőkre épül — fázisonként külön spec-kel és külön implementációs ciklussal.

**Dátum:** 2026-06-28
**Státusz:** Spec 1 jóváhagyott design → writing-plans; Spec 2–3 **vázlat-design** (a részletes, mérés-alapú brainstorm a fázis elérésekor)
**Kapcsolódó:** [`2026-06-28-strategy-tuning-design.md`](./2026-06-28-strategy-tuning-design.md) (az élő `DEFAULT_STRATEGY` hangolása, amire ez épít), [`2026-06-27-strategy-tournament-design.md`](./2026-06-27-strategy-tournament-design.md), [`2026-06-27-backtest-engine-design.md`](./2026-06-27-backtest-engine-design.md)

### Roadmap

| Spec | Fázis | Állapot |
|---|---|---|
| **Spec 1** | Profit-boost a meglévő motorban (momentum-belépő + kockázat-sizing + szelektív érmék) | ✅ Jóváhagyott design → writing-plans |
| **Spec 2** | Always-on worker + gyors exit-sáv (5–15 perc kockázat-kezelés) | 📋 Vázlat-design |
| **Spec 3** | Élesre — valódi pénz, Binance live broker, maker-order, pilot | 📋 Vázlat-design (kapu: pozitív paper-track) |

**Vezérelv (mindhárom fázisra):** előbb **mérünk** (backteszt/paper), aztán építünk; semmi sem megy élesbe bizonyított él nélkül. A Spec 2–3 itt szándékosan **vázlat-szintű** — a részletes designjuk a fázis elérésekor készül, ahogy a Spec 1-nél is előbb mértünk.

---

# Spec 1 — Profit-boost a meglévő motorban

> **Cél:** A bot kockázat-arányos hozamát növelni a **díjakat túlélő** emelőkkel — momentum-belépő, kockázat-alapú méretezés, szelektív érme-kuráció —, mindegyiket **kemény walk-forward backteszt-kapuval**. Semmi sem kerül élesbe, amíg a backtesztben nem veri a jelenlegi defaultot.

**Státusz:** jóváhagyott design → következő lépés: writing-plans

## 1. Probléma és bizonyíték

A felhasználó kérése: **gyorsabb kereskedés (5–10 perc) + legalább $1 nyereség trade-enként + általános profit-boost.** Mielőtt bármit építettünk, **mértünk** (2026-06-28). Az eredmények a kérés egy részét megcáfolták, és átirányították a tervet.

### 1.1 A szűk-TP scalp NEM él — a díjakon bukik (döntő)

Önálló kutató-backteszt, BTC/ETH/SOL, **5 perces** gyertya, ~35 nap, 0,1%/oldal díj + 2 bps slippage (**körköltség ≈ 0,24%**):

| Stratégia | Win-ráta | **avgNet / trade** | Össz |
|---|---|---|---|
| meanRev dip0,3% TP0,3% | 52–58% | **−0,25%** | −70…−91% |
| meanRev TP0,5–1% | 44–59% | **−0,26…−0,32%** | −32…−63% |
| momentum TP0,5–1% | 31–43% | **−0,27…−0,33%** | −25…−78% |

**Minden** konfiguráció bukott. A kulcs: `avgNet/trade ≈ −0,25%` ≈ **maga a körköltség**. Még az 52–59%-os win-rátájú mean-reversion is veszít, mert a szűk TP-t felzabálja a díj. **Több trade = nagyobb veszteség.** Ez **irány-független** (díj-dominált), nem a teszt-ablak eső piaca okozza.

→ **A „$1/trade 5–10 percenként" cél nem reális tőkeáttétel nélkül**, és pont az ellen dolgozik, amitől a bot nyereséges.

### 1.2 A jelenlegi stratégia azért NYER, mert a scalp ellentéte

A meglévő motor (`scripts/backtest.ts`), ugyanazon a friss adaton, **órás** gyertya, 208 nap:

```
Total return +1,96%   Sharpe 2,00   ProfitFactor 2,16
33 trade   Hit 51,5%   Avg win +6,97% / loss −3,33%   maxDD 0,65%   expo 38%
```

A bot **azért nyer, mert türelmes és nagy-célú**: az átlag-nyertes **+6,97%**, amibe a 0,24% díj bele se látszik, és **kevés** trade (33 / 208 nap). A profit-növelés iránya tehát **nem** a gyakoriság, hanem a nagy mozgások jobb elkapása és a tét okosabb allokálása.

### 1.3 Két „kézenfekvő" emelő gyengébb a vártnál (mért)

| Emelő | Eredmény | Tanulság |
|---|---|---|
| Naiv érme-bővítés 3→10 | ret **+1,96% → +0,93%**, Sharpe 2,00→1,01, hit 52%→45% | ❌ Az alt-ok **hígítják** a minőséget → csak **szelektíven** (egyenként backtesztelt érmék). |
| Maker díj 0,1%→0% | ret +1,96% → **+2,20%** | ✅ Pozitív, de **kicsi** (ritka kereskedés). Execution-réteg → **Spec 2/3**, itt nem implementáljuk. |
| Részleges TP (`tpFraction` 0,5) | a mai tournament `[0,5; 1,0]`-t sweepelte, **a teljes kiszállás (1,0) nyert** | ❌ Már le lett tesztelve, vesztett → **kihagyva** (YAGNI). |

---

## 2. Hatókör

**Benne van** (3 emelő, mind backteszt-kapuval):
1. **Momentum-belépő** — kód-alapú trend-belépő a fear-DCA mellé (új `strategy/momentum.ts`).
2. **Kockázat-alapú méretezés** — fix-frakciós kockázat a fix `dcaBuyPct` helyett (új `strategy/sizing.ts`).
3. **Szelektív érme-kuráció** — egyenként backtesztelt, kurált `COIN_UNIVERSE` (új `scripts/coin-screen.ts`).
4. A nyertes emelők átvétele a `DEFAULT_STRATEGY`-be + élesítés (push → GitHub runner) + paper-mérési jegyzet.

**Hatókörön kívül (YAGNI / későbbi spec):**
- Maker/limit-order **végrehajtás** (execution-réteg → Spec 2/3).
- Always-on worker + gyors kód-exit-sáv (5–15 perc) → **Spec 2**.
- Élesítés valódi pénzzel, Binance live broker → **Spec 3**.
- Részleges/ladder take-profit (a tournament már elutasította a `0,5`-öt).
- 5 perces scalp bármilyen formában (1.1 megcáfolta).
- Live trading (marad `paper`).

---

## 3. Komponensek és változó fájlok

Minden új logika **tiszta függvény** (nincs DB/hálózat/`Date.now`/`Math.random`), a meglévő `strategy/` mintára, **TDD-vel**. A kilépést **nem** érintjük — a `evaluatePosition` (stop/TP) + `ratchetStop` (trailing) gépezet egységes marad, az új belépők is ezen szállnak ki.

### 3.1 Momentum-belépő — `src/lib/strategy/momentum.ts` (ÚJ)

A fear-DCA (`evaluateDca`, vesz a mélypontban) **mellé** egy trend-belépő (vesz az erőben), hogy a felfutásokat is elkapja, ne csak a félelmet.

- **Jelzés (kezdő javaslat, a tournament hangolja):** egy coin momentum-BUY-jelet ad, ha
  - `close > SMA(momentumSmaPeriod)` (trend fölött, alap = 24h), **ÉS**
  - `close = az utolsó momentumLookback gyertya legmagasabb close-ja` (breakout, alap = 48h).
- **Kilépés:** a **meglévő** `evaluatePosition` (TP + stop) + `ratchetStop` (trailing). **Nincs új exit-kód.**
- **Interfész (well-bounded):** `evaluateMomentum(ctx, params): MomentumSignal` — tiszta, önállóan tesztelhető. A `ctx` per-symbol gyertya-bufferből számolt SMA-t + lookback-high-t kap (a hívó számolja, ahogy az ATR-t/trendet ma is).
- **Beillesztés:** új order-`kind` `"momentum"` a `PlannedOrder` típusban és a `planProfitCycle`-ben (a DCA-blokk mintájára). A backteszt-motor (`engine.ts`) a **generikus BUY-ágon automatikusan végrehajtja** — nincs új végrehajtó kód. A live `tick.ts` is a `planProfitCycle`-en megy → automatikusan él.
- **Konfliktus-kezelés:** a momentum (vesz a csúcson) és a DCA (vesz a völgyben) különböző regime-ben tüzel; ritkán ütköznek. Mindkettő ugyanazon risk-kapukon megy át (lásd 3.3). Ha mégis egyszerre lenne jel ugyanarra a coinra, a meglévő SELL-előbb-majd-BUY sorrend + a `maxConcurrentPositions` kezeli.
- **Config-bővítés** (`StrategyConfig` + `PROFIT_CYCLE` tükör): `momentumEnabled: boolean`, `momentumSmaPeriod`, `momentumLookback`, `momentumBuyPct`. **Alapból `momentumEnabled: false`** → a meglévő viselkedés és tesztek **változatlanok** maradnak, amíg a backteszt-kapu zöldet nem ad.

### 3.2 Kockázat-alapú méretezés — `src/lib/strategy/sizing.ts` (ÚJ)

A fix `dcaBuyPct` (a tőke 2%-a, vakon) helyett **fix-frakciós kockázat**: a pozíció mérete úgy, hogy a stopig vett veszteség a tőke egy rögzített hányada legyen.

- **Képlet:** `amountUsd = (riskPerTradePct * equity) / ((entry − stop) / entry)`, felülről vágva `maxPositionPct * equity`-re. A tág-stopú (volatilis) coin **kisebb** tételt kap, a szoros-stopú **nagyobbat** — standard risk-parity.
- **Interfész:** `sizeByRisk(equity, entryPrice, stopPrice, params): number` — tiszta, tesztelhető (köztük a clamp + a degenerált `entry==stop` eset).
- **Beillesztés:** a `evaluateDca` és a momentum-belépő amountUsd-számítása ezt hívja, **ha** `riskPerTradePct > 0`; egyébként a régi `dcaBuyPct` viselkedés (visszafelé kompatibilis).
- **Config-bővítés:** `riskPerTradePct` (alap = `0` → régi viselkedés).

### 3.3 Risk-kapuk + backteszt↔live paritás

**Live:** az új belépők ugyanazon a Risk Manager-en mennek át, mint az AI/DCA: `maxPositionPct` (20%), `maxConcurrentPositions` (3), `dailyLossCircuitBreakerPct` (−3%). Új belépő ≠ új kockázati profil.

**Paritás-gotcha:** a backteszt-motorban **NINCS** Risk Manager (az `applyRisk` csak a live `tick.ts`-ben fut) — a `runBacktest` végrehajtja, amit a `planProfitCycle` ad. A mai DCA-nál ez nem gond (a heti keret + egy-coin-pick természetes korlát), de a momentum-belépő **uncapped** lenne a backtesztben, ami **eltérítené a backteszt↔live viselkedést** (a kapu mást mérne, mint ami élesben fut). Ezért a `maxConcurrentPositions` figyelmét a **`planProfitCycle`-be** tesszük (megkapja a `positions[]`-t): új belépő csak akkor kerül a tervbe, ha a nyitott pozíciók száma a `maxConcurrentPositions` limit alatt van. Így **mindkét út azonosan** viselkedik, és a backteszt-kapu a valódi élő viselkedést méri. A `maxPositionPct` clampet a `sizeByRisk` már tartalmazza (3.2).

### 3.4 Szelektív érme-kuráció — `scripts/coin-screen.ts` (ÚJ)

- **Mit csinál:** egy jelölt-lista minden coinját **egyenként** backteszteli a `DEFAULT_STRATEGY`-vel (walk-forward, `loadHistory` + `runBacktest`), és kiír egy rangsort (ret / Sharpe / PF / maxDD / trade).
- **Kapu:** csak a **pozitív OOS hozam ÉS OOS Sharpe ≥ küszöb** (alap: 1,0) coinok kerülnek a kurált univerzumba. (Az 1.3 megmutatta: a naiv 10-es lista rontott.)
- **Kimenet:** report-only, **nincs auto-apply**. A nyertes listát kézzel vesszük át a `COIN_UNIVERSE`-be (`src/lib/config.ts`), a tournament-script mintájára.
- **Élesítési megfontolás:** az új coinok a live `COIN_UNIVERSE`-ben azonnal a collectorokat is bővítik — a plan ellenőrzi, hogy a CoinGecko/Binance collector minden kurált coinra ad-e adatot (különben kiesik).

---

## 4. Adatfolyam (változatlan szerkezet, új belépő + méretezés)

```
óránkénti GitHub runner → run-scheduled-tick → tick.ts
  → collectors (1h klines) → computeAtr + SMA/lookback-high (új) + passesTrendFilter
  → planProfitCycle(input, DEFAULT_STRATEGY)
        ├─ stop/TP (evaluatePosition)  → trailing (ratchetStop)        [változatlan]
        ├─ DCA-belépő (evaluateDca)        → amount: sizeByRisk (új)   [bővített]
        └─ momentum-belépő (evaluateMomentum, ÚJ) → amount: sizeByRisk [új]
  → Risk Manager → Execution (PaperBroker)
```

A backteszt/kuráció adatfolyama (offline, report-only): `loadHistory → splitHistory(0,7) → runBacktest(IS)+runBacktest(OOS) → rankConfigs(robust)`. **Nincs DB-írás, nincs auto-apply.**

---

## 5. Kemény backteszt-kapu (elfogadási feltétel)

Ez a spec gerince. Egy emelő **csak akkor** kerül a `DEFAULT_STRATEGY`-be / élesbe, ha a walk-forward backtesztben (`--robust`, a teljes történelmi adaton):

1. **OOS Sharpe ≥** a jelenlegi default OOS Sharpe-ja, **ÉS**
2. **OOS hozam ≥** a jelenlegi default OOS hozama, **ÉS**
3. **maxDD nem romlik** számottevően (küszöb: ≤ +0,5 százalékpont a defaulthoz képest), **ÉS**
4. mindkét ablakban **pozitív** (IS>0 ÉS OOS>0).

Ha egy emelő nem veri a kaput → **nem szállítjuk** (pontosan mint a scalpernél). Lehetséges kimenet: „egyik emelő sem javít → marad a default + tanulság". Ez is siker (a vérzés elkerülése).

---

## 6. Hibakezelés / kockázatok

- **Overfit / multiple-comparison** → a momentum/sizing paramétereit a `--robust` tournament (IS>0 ÉS OOS>0, `min(IS,OOS)` rangsor) választja, nem egy szerencsés config. A grid kicsi és értelmezhető marad.
- **A momentum „csúcson vásárol" → whipsaw** → a meglévő fix stop + trailing stop védi; a backteszt-kapu (maxDD-feltétel) elkapja, ha rosszabb.
- **Kis él / nagy zaj** → a hozamok aprók (~+2% / 208 nap); a siker = „**kockázat-arányos** javulás", nem pénznyomda. 3–5 nap paper-mérés push után.
- **Teszt-törés a config-bővítésnél** → az új mezők **alapból kikapcsolt** állapota (`momentumEnabled:false`, `riskPerTradePct:0`) garantálja, hogy a meglévő suite zöld marad, amíg a kapu nem dönt. A `config.test.ts` szinkron-állításai lockstepben frissülnek.
- **Új coin adathiány** → a kuráció + a plan ellenőrzi a collector-lefedettséget; adat nélküli coin nem kerül be.

---

## 7. Tesztelési stratégia

- **TDD minden új tiszta függvényre** az implementáció ELŐTT:
  - `evaluateMomentum` — breakout/trend jel BE/KI, SMA/lookback határesetek, üres buffer.
  - `sizeByRisk` — risk-target méret, `maxPositionPct` clamp, degenerált `entry==stop`, `riskPerTradePct=0` → régi viselkedés.
  - `planProfitCycle` — momentum-order megjelenik a tervben, ha jel van; risk-kapuk tisztelve; DCA/momentum együttélés.
- **Backteszt mint kapu** (5. szakasz) — nem unit-teszt, hanem a plan dokumentált, logolt lépése (külső Binance-adat).
- **Teljes kapu élesítés előtt:** `pnpm vitest run` zöld, `pnpm exec tsc --noEmit` 0, `pnpm build` zöld.

---

## 8. Élesítés és mérés

1. `vitest` + `tsc` + `build` zöld.
2. A nyertes emelők átvétele a `DEFAULT_STRATEGY` / `COIN_UNIVERSE`-be (lockstep a `config.ts` ↔ `strategy/config.ts` között).
3. Commit + **push master** → a GitHub óránkénti runner a következő `:07`-es futáskor **automatikusan** az új stratégiával tickel (nulla infra-változás, nincs új secret).
4. **Paper-mérés 3–5 nap:** `/api/market` + `/api/ticks` figyelése, realized vs. backteszt összevetés.
5. A `TRADING_MODE` **marad `paper`**.

---

## 9. Siker-kritérium

- A keményített tournament/kuráció ad **legalább egy** emelőt, ami a 5. szakasz **mind a négy** feltételét teljesíti — **vagy** egyértelmű „nincs javító emelő → marad a default" tanulság.
- A teljes suite + tsc + build **zöld** az átvétel után.
- A live bot a push után a bővített stratégiával tickel (verifikálva a prod API-n + a `tick_runs` naplóban — egyúttal a 2026-06-28-i process-transparency feature **első éles verifikációja** is).
- Dokumentált paper-mérési ablak a realized vs. backteszt összevetésére.

## 10. Backteszt-kapu eredménye (2026-06-28) — ADOPTÁLVA: SEMMI

A Spec 1 implementálva (8 task, TDD, 171 teszt zöld, tsc 0, build zöld). A kapu-mérés a teljes 10-lapos historyn (BTC/ETH/SOL, walk-forward 70/30, díj 0,1% + 5bps):

| Variáns | IS | OOS | Verdikt |
|---|---|---|---|
| **baseline (default)** | +0.52% / Sh 0.58 | **+1.83% / Sh 2.75 / maxDD 0.58%** | referencia (mindkét ablak +) |
| momentum lb48 | −0.85% / Sh −0.54 | −1.25% / Sh −1.72 | ❌ mindkét ablak NEGATÍV (142t, whipsaw) |
| momentum lb24 | −0.67% | +0.04% / Sh 0.06 | ❌ IS negatív, OOS << default |
| momentum + risk1% | −8.45% / maxDD 20.7% | −13.25% / maxDD 16.3% | ❌❌ katasztrófa |
| DCA risk1% | +5.40% / Sh 1.59 | +1.48% / Sh 0.77 / maxDD 2.27% | ❌ OOS Sharpe+ret rosszabb, maxDD romlik |
| DCA risk0.5% | +2.69% | +0.75% / Sh 0.77 | ❌ OOS rosszabb |

**Érme-kuráció (coin-screen, egyéni):** kapun túl DOGE/XRP/BTC/ETH (Sharpe ≥ 1); SOL egyénileg bukik (−0.13). DE a **kombinált** univerzum-teszt:

| Univerzum | IS | OOS |
|---|---|---|
| **BTC,ETH,SOL (baseline)** | **+0.52%** | +1.83% / Sh 2.75 |
| DOGE,XRP,BTC,ETH | −0.59% (neg) | +1.80% / Sh 2.76 |
| +DOGE,XRP (5-coin) | −0.12% (neg) | +1.56% / Sh 2.36 |
| BTC,ETH (SOL nélkül) | −0.25% (neg) | +1.90% / Sh 2.76 |

A baseline BTC/ETH/SOL az **EGYETLEN** univerzum, ahol **mindkét ablak pozitív**; minden alternatíva negatív IS-t ad, és az OOS sem érdemben jobb.

**Döntés (bizonyíték-alapú):** egyik emelő sem veri a kaput → **a `DEFAULT_STRATEGY` és `COIN_UNIVERSE` változatlan** (momentum OFF, risk 0, BTC/ETH/SOL). A momentum-belépő pénzt veszít (csúcson vásárol, whipsaw), a risk-sizing overfittel + növeli a drawdownt, a türelmes 3-coin DCA marad a legjobb. **A megépített gépezet (momentum, sizing, coin-screen) a helyén marad, alapból kikapcsolva** — backteszt-validált, jövőbeli használatra kész, de aktiválva semmi. (Ugyanaz a mintázat, mint a scalpernél: mérünk, nem tippelünk; a kapu megvédett egy rossz változtatástól.)

---

# Spec 2 — Always-on worker + gyors exit-sáv

> **Cél:** A „gyorsítás" — a kockázat-kezelés (stop / take-profit / trailing) **percekben** hasson, ne órákban —, **fee-bleed nélkül**, egy megbízható always-on futtatókörnyezetben.
> **Státusz:** vázlat-design. A részletes brainstorm (hosting-választás, cadence, mérés) a fázis elérésekor. **Előfeltétel:** a Spec 1 papíron bizonyított.

## 2.1 Probléma

- A GitHub Actions cron **megbízhatatlan** sub-hourly: a 2026-06-28-i mérésnél 24h alatt **~10 tick futott a ~24 helyett**, és a 15:07-es ki is maradt. A cron órás nagyságrendre való.
- Az **órás** tick miatt egy stop akár egy óráig is **áthágott** állapotban maradhat a következő futásig → rosszabb fill, nagyobb tail-kockázat.
- A „gyorsabban kereskedjen" igény **helyes formája**: gyorsabb **kockázat-kezelés** (exit), NEM gyorsabb belépő-churn (azt az 1.1 megcáfolta).

## 2.2 Hatókör

**Benne:** always-on worker; kód-alapú gyors exit-modul (5–15 perc); a meglévő exit-gépezet újrahasználata egy közös függvényben; a worker ↔ hourly-tick koordináció.
**Kívül:** új belépők (maradnak az órás AI / DCA / momentum sávban); maker-order (Spec 3); valódi pénz (Spec 3).

## 2.3 Komponensek

- **Always-on worker** (Fly.io / Railway / Render — döntés a brainstormkor): hosszú-életű Node-folyamat `setInterval`-hurokkal. **Fő fázis-döntés:** a worker CSAK a gyors exit-sávot hajtja (a belépő marad a GitHub cronon), VAGY átveszi a hourly tick-et is (megbízhatóbb, mint a cron). Javasolt kiindulás: a worker hajtja **mindkettőt** → a cron-hézagok megszűnnek.
- **Gyors exit-modul** — `src/lib/engine/fast-exit.ts` (ÚJ): betölti a nyitott pozíciókat + élő árat (Binance ticker), futtatja a tiszta `evaluatePosition` (stop/TP) + `ratchetStop` (trailing) függvényeket, és **csak EXIT-ordereket** hajt végre. Nincs LLM, nincs új belépő → **nincs fee-churn** (csak valódi triggerre köt).
- **Közös exit-logika** (refaktor): a `planProfitCycle` exit-fele kiemelhető egy `planExits(positions, candles, config)` tiszta függvénybe, amit a **hourly tick ÉS a fast-exit is hív** → egy forrás, nincs drift (a tournament-spec lockstep-mintája).
- **Koordináció / idempotencia:** a fast-exit és a hourly tick ne ütközzön — a DB a single source; a `setStopPrice` már perzisztálja a trailing-et a tickek között; pozíció-szintű atomicitás (a SELL után a pozíció lezárt állapota dönt).

## 2.4 Adatfolyam

```
worker loop (5–15 perc) → fast-exit → Binance ticker (élő ár)
  → planExits(positions, DEFAULT_STRATEGY) → execute SELL (PaperBroker) → setStopPrice perzisztál
worker loop (óránként)   → executeScheduledTick  (a meglévő belépő-lánc, változatlan)
```

## 2.5 Kockázatok

- **Worker leáll** → a platform health-check auto-restart; a tick `tickId`-dedup idempotens → nincs dupla.
- **Fast-exit ↔ hourly race** → közös `planExits` + a DB single source; a degenerált band (low=high=close=spot) élesben a meglévő mintát követi.
- **Költség** → egy folyamat, ingyenes/olcsó tier elég.

## 2.6 Siker-kritérium

- A stop/TP **percekben** hajtódik végre (nem órákban), verifikálva a `tick_runs`/exit-naplóból.
- **Nincs fee-churn** (a fast-exit csak triggerre köt — a trade-szám nem ugrik meg drámaian).
- Megbízható cadence — nincs többé többórás hézag.

---

# Spec 3 — Élesre (valódi pénz)

> **Cél:** A papíron bizonyított stratégiát **kicsi, szigorúan limitált** valódi pénzes pilotba vinni.
> **Státusz:** vázlat-design. **Kemény kapu:** csak a Spec 1–2 **pozitív paper-track**-je után indul.

## 3.1 Probléma / előfeltétel

- A `BinanceBroker` jelenleg **STUB** (nincs valódi API-hívás; a live út **nincs verifikálva**).
- Valódi **díj** (0,1% taker) + **slippage** + **rate-limit** + **kulcs-biztonság** lép be — papíron ezek szimuláltak.

## 3.2 Hatókör

**Benne:** `BinanceBroker` valódi implementáció + verifikáció (testnet → kis valódi order); **maker / limit-order** (a Spec 1-ből ide halasztott díj-csökkentő lever); valódi fee/slippage kezelés; **kill-switch**; kicsi pilot.
**Kívül:** tőkeáttétel / margin (**SOHA**); nagy tét (a pilot szándékosan kicsi); új stratégia-elem (a Spec 1–2 terméke megy élesbe).

## 3.3 Komponensek

- **`BinanceBroker`** (`src/lib/execution/binance-broker.ts`): valódi signed REST order-küldés + fill-visszaolvasás + hibakezelés. API-kulcs **read+trade only, NO withdraw**.
- **Maker / limit orderek:** limit-ár a spread maker-oldalán → ~0% díj a 0,1% taker helyett (az 1.3 szerint kis, de pozitív hatás; gyors sávnál fontosabb). A **nem-fill** kezelése: re-quote vagy fallback market, monitoringgal.
- **Kill-switch:** globális stop (env-flag vagy DB-`settings`), ami minden új belépőt letilt; a meglévő `dailyLossCircuitBreakerPct` (−3%) élesben szigorítható.
- **Pilot-keret:** kicsi valódi tőke (pl. $50–100), szűk `maxPositionPct`, napi veszteség-limit, **kézi engedély** a skálázáshoz.
- **Secrets:** `BINANCE_API_KEY` / `BINANCE_API_SECRET` a worker + a Vercel env-ben (a meglévő secret-kezelés mintájára).

## 3.4 Kockázatok

- **Valódi pénz-veszteség** → szigorú limitek + kill-switch + kicsi pilot + a paper-kapu (a fő védelem).
- **Kulcs-szivárgás** → read+trade only (no withdraw), gondos secret-kezelés, kulcs-rotáció.
- **Slippage / nem-fill maker-nél** → fallback logika + monitoring.

## 3.5 Siker-kritérium

- `BinanceBroker` verifikált (testnet → egy kis valódi order sikeres oda-vissza).
- A pilot a paper-várakozással **összevethető** realized eredményt hoz, a limiteken belül.
- A kill-switch bizonyítottan működik.

---

# Appendix — Elvetett / halasztott ötletek (hogy a döntések ne vesszenek el)

| Ötlet | Döntés | Indok (bizonyíték) |
|---|---|---|
| **Szűk-TP scalp 5–10 perc** (a kiinduló kérés) | ❌ Elvetve | A 2026-06-28-i 5m backteszt: **minden** config bukott, `avgNet/trade ≈ −0,25%` ≈ a körköltség. Díj-dominált, irány-független. |
| **„$1 nyereség trade-enként" garancia** | ❌ Nem reális | $100 tőke, 20% max pozíció = $20 → $1 = 5% mozgás; majoreken 5–10 perc alatt szinte soha. Tőkeáttétel nélkül nem megy (a margin tiltott). Átfogalmazva: több/nagyobb nyerő trade, nem per-trade garancia. |
| **Naiv érme-bővítés (3→10)** | ❌ Elvetve | Mért: ret +1,96% → **+0,93%**, Sharpe 2,00→1,01. Az alt-ok hígítják a minőséget. → Helyette **szelektív** kuráció (Spec 1, 3.4). |
| **Részleges / ladder take-profit** | ❌ Elvetve (Spec 1-ből) | A mai tournament a `tpFraction [0,5; 1,0]`-t sweepelte, **a teljes kiszállás nyert**. |
| **Mély scalp-kutatás (maker ~0% + ML / order-book jel)** | 🔁 Nyitva, nem most | Elméletileg lehet edge maker-díjjal, de **külön kutatási projekt**; retail ritkán nyeri az HFT-microstructure játékot. Csak ha a Spec 1–3 kimerült. |
| **Maker / limit-order végrehajtás** | ⏸ Halasztva → Spec 3 | Execution-réteg; a patient stratégiánál kis hatás (+0,24pp), gyors sávnál fontosabb. |

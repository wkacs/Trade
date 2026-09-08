# Javítási terv — a 2026-09-08-i Codex-audit alapján

Forrás: `docs/2026-09-08-codex-strategy-review-claude.md` (Codex, checkout `7abef22`).
Ez a fájl a VÉGREHAJTÁSI lista: mit javítunk, milyen bizonyítékkal, és mi marad ki tudatosan.

## Ellenőrzés kódban (2026-09-08)

Mind a 7 P1 megállapítást visszaigazoltam forrásból, mielőtt bármit átírtam volna:

| # | megállapítás | státusz | hely |
|---|---|---|---|
| 1 | a részvény napi veszteségkapu ki van kerülve | **VALÓS** | `stock-tick.ts:496-497` — `dailyLossLatched: false` bedrótozva |
| 2 | a kötési ár múltbeli gyertyazáró, nincs frissesség-kapu | **VALÓS** | `stock-tick.ts:455-456` — a `market()` a bar close-t adja `last`-ként, életkor-ellenőrzés nélkül |
| 3 | a nap végi zárás nem garantált (tört készlet bent maradhat) | **VALÓS** | `alpaca.ts:154` — egyetlen hibás metaadat → `allFractionable=false` → `execution.ts:43` egész lot MINDEN orderre, az eladásra is |
| 4 | jövőbeli ár a kripto-backteszt nyitáskori kockázatában | **VALÓS** | `backtest/engine.ts:106-113` — a `priceMap` a MOSTANI bar `close`-át adja, a fill viszont `at: "open"` |
| 5 | az L2/L3 nem a meghirdetett heti keretet méri | **VALÓS** | `weekly-budget.ts:122` — globális `PROFIT_CYCLE.dcaWeeklyBudgetPct` (5%) a sáv 20%-a helyett |
| 6 | backteszt ↔ futó rendszer eltérések | **VALÓS** | `backtest/engine.ts:121` napi latch mindig false; a `buyLog` a momentum-vételt is a DCA-keretbe számolja |
| 7 | a kripto út figyelmen kívül hagyja az elutasított könyvelést | **VALÓS** | `tick.ts:450-451` — a `persistFill` kimenete eldobva; `execute-intent.ts:183` a `deps.persist` visszatérési értéke `void` |

## Sorrend és hatókör

Az audit sorrendjét követem (1 → 3 → 7, utána 2 → 4 → 6 → 5), mert az első három a
KÖNYVELÉS és a KOCKÁZAT hitelességéről szól, a többi a mérés paritásáról.

| # | mit csinálunk | reprodukciós teszt |
|---|---|---|
| 1 | stock-paper hatókörű napi equity-referencia + veszteség-latch; hiányzó baseline tiltja az új BUY-t, a csökkentő SELL megy | limit átlépése után nincs belépő; stop és EOD-zárás továbbra is megy |
| 3 | a ZÁRHATÓSÁG elválik az új belépés metaadat-kapujától: az eladás a pozíció tényleges mennyiségét tudja zárni akkor is, ha a fractionable-kapu zárva van | 1,5 és 0,5 darabos pozíció flattenje; null metaadat ne kerüljön tartósan cache-be |
| 7 | a tartós könyvelés eredménye az execution szerződés része: `persist` outcome-ot ad vissza, a nem-alkalmazott (pl. `fenced`) MEGÁLLÍTJA a ciklust, a duplikátum idempotens ág | `fenced` → nincs hamis siker és nincs továbbköltés; `duplicate_fill` → nincs dupla delta |
| 2 | (rész) adat-életkor kapu az ÉLES részvény-úton: elavult gyertyából nincs új belépő | elavult sorozat → nincs BUY, a védelmi kilépés megmarad |
| 4 | a nyitáskori kockázat-értékelés a NYITÓ árat lássa, ne a még ki nem alakult zárót | azonos múlt + azonos nyitó, eltérő záró → azonos nyitáskori kötés |
| 6 | a backteszt napi kapuja a futó rendszerével egyezzen; a momentum-vétel NE fogyassza a DCA heti keretét | momentum-vétel után a DCA kerete változatlan; napi limit a backtesztben is tilt |
| 5 | a heti keret a ténylegesen futó stratégia `dcaWeeklyBudgetPct`-jét használja | azonos equity: baseline 5%, L2/L3 20% |

## Amit tudatosan NEM csinálok ebben a körben

- **A 2. pont TELJES alakja** (külön `signalAsOf`/`observedAt`/`decisionAt`/`executionAt`
  időbélyegek, időbélyeges bid/ask, a backtesztben a jel UTÁNI végrehajtható árra
  ugrás). Ez nem hibajavítás, hanem a végrehajtási modell átépítése: MINDEN eddigi mért
  szám érvénytelenné válik tőle, és önálló mérési kört igényel. Amit most beteszek: a
  frissesség-KAPU az éles úton, plusz a backtesztbe egy kapcsolható `--fill next-open`
  konvenció, hogy a kérdés MÉRHETŐ legyen, ne hiedelem.
- **K1–K6** (döntési napló, közös belépési korlátok, score, chart, főoldali státusz).
  Ezek termék-funkciók, nem az audit hibái; az audit maga is a K0 (1–7. hiba) után
  sorolja őket.
- **A régi mérések újragenerálása.** A 4. és 6. pont javítása után a kripto backteszt
  számai megváltoznak; az érvényességi címkézés a javítások után, külön lépésben jön.

## Státusz — mind a 7 pont javítva (2026-09-08)

| # | státusz | reprodukciós teszt (bukott → zöld) |
|---|---|---|
| 1 | ✅ kész | `stock-tick.test.ts` napi veszteségkapu (4 eset) + `day-equity.test.ts` injektált nap-definíció (4 eset) + `calendar.test.ts` `sessionOpenMs` (3 eset) |
| 3 | ✅ kész | `stock-tick.test.ts` zárhatóság (4 eset) + `execution.test.ts` `stockClosingFilters` (3) + `alpaca.test.ts` cache (2) + `run-scheduled-stock-tick.test.ts` maradvány-figyelmeztetés (2) |
| 7 | ✅ kész | `execute-intent.test.ts` elutasított könyvelés (4 eset) |
| 2 (rész) | ✅ kész | `stock-tick.test.ts` frissesség-kapu (4 eset) + végrehajtási ár felülírás (1) |
| 4 | ✅ kész | `backtest/engine.test.ts` nyitáskori kötés a záróártól függetlenül |
| 6 | ✅ kész | `backtest/engine.test.ts` momentum nem fogyasztja a DCA-keretet + napi latch a backtesztben |
| 5 | ✅ kész | `weekly-budget.test.ts` sáv-szintű keret (320 USD-n 64, nem 16) |

### Amit a javítások konkrétan csinálnak

1. **Napi veszteségkapu (részvény).** `runStockCycle` kapott egy injektálható
   `resolveDayGate`-et: az éles runnerek a DB-s `resolveDayGate`-tel kötik be, ÜLÉS-napra
   (ET dátum) és az aznapi 09:30 ET nyitáshoz mérve, `stock-paper` hatókörben (a kripto
   napi kapujától elkülönítve). A backteszt ugyanazt a tiszta `evaluateDayGate`-et futtatja
   memóriában — így a mérés és az éles ág ugyanazt a szabályt alkalmazza. A latch csak ÚJ
   vételt tilt; a stop, a take-profit és a nap végi zárás fut tovább.
2. **Zárhatóság.** Új `stockClosingFilters`: egy MEGLÉVŐ pozíció zárása a tényleges készletet
   követi (apró lépésköz, nincs min. kötésérték). A `PaperExecutionBroker` mostantól
   intentenként kaphat paramétert (`paramsFor`), így a VÉTEL marad konzervatív egész lot,
   az ELADÁS viszont 1,5 vagy 0,5 darabot is teljesen zár. Az Alpaca metaadat-cache többé
   nem tárol sikertelen lekérést (egy átmeneti 500-as nem fagyaszt be egy papírt a TTL
   végéig). A `flatten` után a ciklus MEGNÉZI a tényleges maradékot: ami nyitva maradt, az
   `unflattened` mezőben megnevezve látszik, a runner `ok: false`-t ad
   (`reason: "flatten_incomplete"`), nem néma sikert.
3. **Hiteles könyvelés.** A `persist` visszatérési értéke az execution szerződés része. Egy
   `fenced` (lejárt lease miatti) elutasítás MEGÁLLÍTJA a végrehajtást: nincs hamis siker,
   nincs továbbköltés, és a régi dashboard-vetület sem kap nem könyvelt kötést. A
   `duplicate_fill` külön, idempotens ág.
4. **Frissesség-kapu.** Elavult gyertyasorból nincs ÚJ belépő (intraday 3 bar, napi 36 óra;
   `defaultMaxBarAgeMs`). A kilépés nem tiltott. Az érintett papírok `staleSymbols`-ban
   megnevezve jönnek vissza, a runner naplózza őket.
5. **Backteszt nyitáskori értékelés.** A nyitón végrehajtott order kockázati kontextusa és
   heti kerete a NYITÓ árakból számol; a bar záróára a döntés idején még nem létezik.
6. **Backteszt ↔ élő paritás.** A napi veszteség-latch a backtesztben is tilt, és a
   momentum-vétel nem fogyasztja a DCA heti keretét (a költés `dca` eredetű, BRUTTÓ
   fill-értéken, pontosan úgy, ahogy a `spentThisWeekUsd`).
7. **Heti keret.** A `remainingWeeklyBudget` a ténylegesen futó stratégia
   `dcaWeeklyBudgetPct`-jét kapja meg.

## Mérési következmények (futtatva, nem feltételezve)

| kérdés | mérés | következtetés |
|---|---|---|
| Mennyit visz el a napi veszteségkapu a részvény-backtesztből? | `tod60+regime`, 10%/3 poz: **+1,69% előtte és utána is** | a 3%-os napi latch ezen a 60 napos mintán EGYSZER SEM aktivált — a kapu nem költség, csak eddig hiányzó védelem |
| Mennyit ér a stratégia, ha a végrehajtás egy barral KÉSIK? | `--fill next-open`: **+1,72%** a mai konvenció +1,69%-a helyett (t 2,11 vs 2,08) | a mért él NEM abból jött, hogy a backteszt a jel pillanatában köt; egy bar késleltetés nem rontja el |
| A kripto-backteszt régi számai érvényesek maradnak? | a 4. és 6. javítás megváltoztatja a nyitáskori keretet és a DCA-költést | **a javítás ELŐTTI kripto-jelentéseket újra kell generálni**; az L2/L3 sávok korábbi adata ráadásul 5%-os heti kerettel futott a meghirdetett 20% helyett — ezek HIBÁS KONFIGURÁCIÓJÚ mérésként címkézendők |

## Futtatott ellenőrzések

- `npx tsc --noEmit` — hibátlan.
- `npx vitest run` — **92 fájl, 1035 teszt zöld** (az audit előtti állapot 980 volt; a
  különbség a fenti reprodukciós tesztek).
- `scripts/stock-intraday-backtest.ts --sweep ranking` a 4 és a 30 papíros univerzumon,
  beépített és `tod60+regime` belépő-alakkal, plusz `--fill next-open` kontroll.

## Utókör — a saját javítás átvizsgálása (2026-09-08, Codex-visszajelzés után)

A Codex visszajelzése szerint a javítás nem volt kész. Újra átnéztem a saját munkámat, és
NÉGY valós hibát találtam benne. Mind reprodukálva, majd javítva:

| hiba | miért rossz | javítás |
|---|---|---|
| A duplikátum-ág MÁSODSZOR alkalmazta a deltát (`execute-intent.ts`) | a `loadLedgerState` a DB egyenlegeiből épít, de `appliedFillKeys: []`-szel: a memóriabeli dedup NEM látja a DB-ben már meglévő fillt. Ha a persist duplikátumot jelzett, a delta ráfutott a MÁR FRISS állapotra (a repró: 100 USD-ből 90 lett) | duplikátumnál nem vezetjük tovább a memóriabeli állapotot, a fill nem számít új kötésnek, és a `reasons` megnevezi |
| Kitalált equity a részvény napi kapuban (`stock-tick.ts`) | az `equityUsd()` kihagyja az ártalan pozíciókat, így egy hiányzó gyertya úgy látszott, mintha a pozíció nullát érne — hamis napi veszteség-latch vagy hamis napkezdő referencia | nem mérhető equity esetén `null` megy a kapunak (ahogy a kripto ág is teszi), és az új vétel szünetel |
| Ugyanez a kripto-backtesztben (`backtest/engine.ts`) | `equityAt` hiányos ár-térképpel: ugyanaz a hamis napi hozam, csak a mérésben | `null`, ha egy birtokolt papírra nincs ár abban a keretben |
| A frissesség-kapu csak a momentum-utat zárta (`stock-tick.ts`) | elavult sorozaton a fear-DCA belépő továbbra is nyitva volt (a trend-engedélyen és a jelölt-listán át) | az elavult papír kiesik a trend-engedélyből ÉS a jelölt-listából is |

Tanulság a folyamatra: az „1035 teszt zöld" nem bizonyíték. Mind a négy hiba ÚJ, célzott
reprodukciós tesztet igényelt; a meglévő suite egyiket sem fogta meg.

## Ami továbbra is nyitva van

- **A 2. pont teljes alakja**: külön `signalAsOf`/`observedAt`/`decisionAt`/`executionAt`
  időbélyegek és időbélyeges bid/ask. A frissesség-kapu és a késleltetés-mérés bekerült, a
  végrehajtási modell átépítése nem.
- **A kripto-jelentések regenerálása** a 4. és 6. javítás után, a régi számok címkézésével.
- **K1–K6** (döntési napló, közös belépési korlátok, score, chart, főoldali státusz) — az
  audit maga is a K0 után sorolja őket.

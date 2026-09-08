# Momentum-rangsor: kockázat-korrigált kiválasztás és a szélesség újramérése

Dátum: 2026-09-08 · Mérési ablak: 60 nap, 5 perces gyertya (a Yahoo intraday maximuma)

## 1. A kérdés

A day-trading sáv belépője két külön döntés:

1. **Jogosultság** — melyik papír van kitörésben (`ENTRY_SHAPES`, mérve).
2. **Kiválasztás** — ha több jogosult van, melyiket vesszük meg. Ez eddig **nem volt mérve**:
   a `evaluateMomentum` a nyers periódus-változás maximumát vette.

Négy papíron a 2. pont majdnem mindegy (ritkán van választás). Széles univerzumon viszont
a nyers maximum SZISZTEMATIKUSAN torzít: minél több nevet figyelünk, annál nagyobb a
legnagyobb kilengés, és az szinte mindig a legvolatilisebb papíré. Vagyis a szélesítés a
kitörés helyett a legnagyobb zajt vásárolja meg.

Ez volt a hipotézis arra, hogy a 2026-09-08-i szélesség-mérés (4 → 30 papír) miért bukott:
nem a szélesség rossz, hanem a kiválasztás.

## 2. Amit a kód kapott

Új modul: `src/lib/strategy/momentum-ranking.ts` — cserélhető rangsorok, ugyanazzal a
mintával, mint a belépő-alakok:

| név | képlet | jelentés |
|---|---|---|
| `raw` (alap) | `change%` | a mai viselkedés: a legnagyobb ugrás nyer |
| `risk-adjusted` | `change% / ATR%` | a változás a papír SAJÁT volatilitásának egységében |
| `rs-risk-adjusted` | `(change% − SPY%) / ATR%` | piac-korrigált változás, volatilitásra osztva |

Az ATR az ÁRHOZ mérten (ATR%) megy a rangsorba, különben a drágább papír pusztán a nagyobb
abszolút ingásától tűnne volatilisebbnek. ATR nélküli jelölt nem rangsorolható, és
**kiesik** — nem esik vissza nyers százalékra (a két mérték nagyságrendje más, a keverésük
némán mindig az ATR-telen jelöltet hozná ki győztesnek).

**Önálló relatív-erő rangsor NINCS.** A benchmark egy cikluson belül minden jelöltre
ugyanaz, egy konstans eltolás pedig nem tud sorrendet változtatni. A mérés ezt sorról sorra
visszaigazolta: a nyers és a relatív-erő rangsor hozama, trade-száma és maxDD-je bitre
azonos volt. Jelentése csak osztva van (`rs-risk-adjusted`).

Bekötés:

- `planStockCycle({ momentumRanking })` és `runStockCycle({ momentumRanking })` — opcionális.
- Élesben: `STOCK_MOMENTUM_RANKING` env (csak a day-trading sáv). Üresen `raw`, tehát az
  élő viselkedés VÁLTOZATLAN. Ismeretlen névre figyelmeztet és marad a nyers rangsor.
- Mérés: `pnpm tsx scripts/stock-intraday-backtest.ts --sweep ranking [--wide] [--shape <alak>]`

## 3. A verseny

Minden sor UGYANAZT a jelet, kockázati keretet, méretezést, stopot, nap végi zárást és
végrehajtási költséget kapja; csak a kiválasztás más. Tört részvénnyel. A 60 nap MINDKÉT
fele külön is mérve — egy szerencsés ablak így kiderül.

### 3a. Beépített kitörés-jel, 10% tétel / 3 pozíció

| univerzum | rangsor | 1. fél | 2. fél | teljes | maxDD | t | robusztus |
|---|---|---|---|---|---|---|---|
| 4 papír | `raw` | +0,34% | +0,70% | **+1,04%** | 0,94% | 1,00 | IGEN |
| 4 papír | `rs-risk-adjusted` | +0,34% | +0,69% | +1,03% | 0,94% | 0,99 | IGEN |
| 4 papír | `risk-adjusted` | +0,38% | +0,58% | +0,96% | 0,95% | 0,92 | IGEN |
| 30 papír | `rs-risk-adjusted` | −1,35% | +2,37% | +1,26% | 2,89% | 0,50 | nem |
| 30 papír | `raw` | −1,17% | +1,95% | +0,94% | 3,36% | 0,36 | nem |
| 30 papír | `risk-adjusted` | −1,59% | +2,12% | +0,76% | 2,90% | 0,31 | nem |

### 3b. Az ÉLES belépő-alakkal (`tod60+regime`), 10% tétel / 3 pozíció

| univerzum | rangsor | 1. fél | 2. fél | teljes | maxDD | t | robusztus |
|---|---|---|---|---|---|---|---|
| 4 papír | `raw` | +0,37% | +1,32% | **+1,69%** | 0,80% | **2,08** | IGEN |
| 4 papír | `rs-risk-adjusted` | +0,37% | +1,32% | +1,69% | 0,80% | 2,08 | IGEN |
| 4 papír | `risk-adjusted` | +0,41% | +1,21% | +1,63% | 0,81% | 1,97 | IGEN |
| 30 papír | `raw` | −1,13% | +3,46% | +2,28% | 2,75% | 0,93 | nem |
| 30 papír | `risk-adjusted` | −1,52% | +3,51% | +2,02% | 2,47% | 0,90 | nem |
| 30 papír | `rs-risk-adjusted` | −1,84% | +3,37% | +1,55% | 2,47% | 0,68 | nem |

## 4. Verdikt: a hipotézis MEGBUKOTT, nincs átállítás

- **A kockázat-korrigált rangsor nem javított.** Az éles belépő-alakkal MINDKÉT
  univerzumon ROSSZABB a nyersnél (4 papír: +1,63% vs +1,69%; 30 papír: +2,02% vs +2,28%).
- **A szélesség bukása nem kiválasztási hiba volt.** A 30 papíros sorok a nagyobb teljes
  hozam ellenére mind elbuknak az őszinte próbán: az ELSŐ fél MINDEGYIKNÉL negatív, a maxDD
  3-4-szerese a 4 papírosnak, és `t ≈ 0,9` — vagyis a sorrend nem különböztethető meg a
  véletlentől. A 4 papíros éles beállítás `t = 2,08`-cal és két pozitív féllel az EGYETLEN,
  ami átmegy.
- Az alapértelmezés marad `raw`, a `STOCK_MOMENTUM_RANKING` üres. Az élő bot viselkedése
  **nem változott** — a kapcsoló mérési infrastruktúra, ugyanúgy, mint a belépő-alakoké.

Egy megjegyzés a jövőnek: sok egyidejű pozíciónál a rangsor ELŐJELET vált. 30 papír,
3% tétel / 10 pozíció mellett a `risk-adjusted` +0,52%, a `raw` +0,31% — ott a
volatilitás-normalizálás már számít, mert a rangsor mélyebbre nyúl a listában. Ez a
tartomány viszont önmagában veszteséges volt, tehát nem ajánlás.

## 5. Ami nyitva maradt

- **Vol-cap szűrő** (a küszöb feletti ATR%-ú nevek kizárása a rangsorolás ELŐTT) — ez nem
  rangsor, hanem jogosultság, tehát külön mérés.
- **A 60 napos ablak rövid és emelkedő piac.** Mindkét univerzum második fele erősen
  pozitív, az első negatív; a szélesség-kérdés eldöntéséhez több rezsim kellene. Ingyenes
  adatból intraday nem elérhető (a Yahoo kemény korlátja 60 nap).
- **Az univerzum mérete továbbra sem API-korlát.** A `STOCK_CATALOG` 4 eleme a korlát,
  és a mérés szerint ez most helyes állapot.

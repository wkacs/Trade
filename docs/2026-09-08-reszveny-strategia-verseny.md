# Melyik day-trading stratégia a legjobb (és a leggyorsabb)?

**Dátum:** 2026-09-08 · **Mód:** paper · **Sáv:** `stock-paper` (USD) · **Adat:** Yahoo 5 perces
gyertya, 60 nap (2026-06-11 → 2026-09-04), 4681 bar/szimbólum

A kérdés az volt, hogy a részvény-sáv jelenlegi belépője (kitörés a trend fölött) a
legjobb-e, és hogy gyorsabb ritmussal jobb lenne-e. A válasz **mérve** van, nem elvben.

## 1. A módszer

A verseny a **live úton** zajlik: minden variáns ugyanazt a döntés-agyat
(`planStockCycle`), ugyanazt a végrehajtást (risk-manager + PaperExecutionBroker +
díj/spread/slippage), ugyanazt a kockázati keretet (10% tétel, 3 egyidejű pozíció, 5%
katasztrófa-stop, 10% take-profit) és ugyanazt a nap végi laposra zárást kapja. **Egyedül
a belépő jele más.**

Ehhez a belépő cserélhetővé vált: `src/lib/strategy/intraday-entries.ts` tiszta
függvényekben tartja az alakokat, a `planStockCycle` pedig opcionális `entryShape`-et
fogad. Ha nem kap, a régi beépített jel dönt, tehát az éles viselkedés magától nem
változik.

**Az első ellenőrzés az volt, hogy a becsatlakozás nem torzít-e:** a `breakout` alak
(a jelenlegi éles jel újraimplementálva) **pontosan** a korábban dokumentált számot adta
vissza (+1,08%, 98 trade, 55% találat, 0,81% maxDD, felezve +0,39% / +0,68%). Enélkül a
teljes verseny értelmezhetetlen lenne.

## 2. A belépő-alakok versenye

Mind a 22 alak, 60 nap, a 4 aktív papíron. „Robusztus" = a 60 nap **mindkét** felén
pozitív. Az `átlag/trade` a méret nélküli jel-minőség, a `t` durva zaj-mérce.

| alak | 1. fél | 2. fél | teljes | trade | win | maxDD | átlag/trade | t | robusztus |
|---|---|---|---|---|---|---|---|---|---|
| tod60+regime | +0,39% | +1,19% | **+1,56%** | 55 | 65% | **0,68%** | **+0,306%** | 2,08 | IGEN |
| tod-60 | +0,50% | +1,08% | +1,55% | 69 | 61% | 0,86% | +0,232% | 1,66 | IGEN |
| tod90+regime | +0,43% | +1,10% | +1,50% | 59 | 63% | 0,68% | +0,275% | 1,99 | IGEN |
| tod-open (90 perc) | +0,54% | +0,91% | +1,41% | 74 | 58% | 0,86% | +0,196% | 1,48 | IGEN |
| tod-120 | +0,53% | +0,90% | +1,40% | 82 | 57% | 0,86% | +0,173% | 1,45 | IGEN |
| tod120+regime | +0,43% | +0,98% | +1,38% | 67 | 61% | 0,73% | +0,218% | 1,73 | IGEN |
| tod-30 | +0,26% | +1,07% | +1,32% | 61 | 59% | 0,85% | +0,215% | 1,37 | IGEN |
| tod-150 | +0,40% | +0,85% | +1,22% | 87 | 55% | 0,91% | +0,142% | 1,24 | IGEN |
| tod-210 | +0,34% | +0,85% | +1,17% | 91 | 54% | 0,87% | +0,129% | 1,18 | IGEN |
| regime-spy | +0,59% | +0,58% | +1,15% | 84 | 58% | 0,76% | +0,141% | 1,29 | IGEN |
| **breakout (JELENLEG ÉLES)** | +0,39% | +0,68% | +1,08% | 98 | 55% | 0,81% | +0,106% | 1,00 | IGEN |
| orb15-trend | +0,81% | −0,39% | +0,50% | 121 | 47% | 0,85% | +0,029% | 0,32 | nem |
| vwap-cross | +0,64% | −0,32% | +0,34% | 164 | 46% | 1,45% | +0,004% | 0,05 | nem |
| tod-30-120 | +0,64% | −0,34% | +0,30% | 63 | 54% | 0,57% | +0,036% | 0,31 | nem |
| pullback (mean reversion) | +0,24% | −0,06% | +0,18% | 90 | 43% | 0,81% | −0,003% | −0,03 | nem |
| orb15 | +0,42% | −0,33% | +0,16% | 128 | 44% | 0,96% | −0,008% | −0,10 | nem |
| gap-go | +0,26% | −0,26% | 0,00% | 55 | 47% | 0,57% | +0,004% | 0,03 | nem |
| orb30-trend | +0,74% | −0,84% | −0,19% | 116 | 47% | 1,24% | −0,022% | −0,27 | nem |
| vwap-trend | −0,47% | +0,22% | −0,25% | 174 | 42% | 2,04% | −0,038% | −0,40 | nem |
| orb30 | +0,59% | −0,81% | −0,31% | 122 | 44% | 1,21% | −0,038% | −0,49 | nem |
| orb60 | +0,61% | −1,14% | −0,55% | 103 | 43% | 1,47% | −0,083% | −1,20 | nem |
| tod-power (zárás előtti 90 perc) | −0,19% | −0,51% | −0,70% | 27 | 26% | 0,76% | −0,309% | −2,54 | nem |

**A klasszikusok megbuktak.** Az opening range breakout (a day trading tankönyvi
belépője), a VWAP és a mean reversion mind rosszabb a meglévő jelnél, és egyik sem
pozitív a 60 nap mindkét felén. A piac ezen a skálán trendkövető, nem visszahúzó.

**A nyertes nem új stratégia, hanem egy SZŰRŐ a meglévőn:** csak az ülés első órájában
lépj be, és csak akkor, ha a piac (SPY) a saját trendje fölött van.

## 3. Hol keletkezik a hozam? (szakasz-bontás)

Egymást **nem fedő** ülés-szakaszok, ugyanaz a kitörés-jel:

| szakasz a nyitástól | átlag/trade | t | teljes | trade |
|---|---|---|---|---|
| **0–30 perc** | **+0,215%** | 1,37 | +1,32% | 61 |
| 30–60 perc | +0,035% | 0,24 | +0,19% | 42 |
| 60–90 perc | +0,015% | 0,11 | +0,14% | 36 |
| 90–150 perc | −0,207% | −2,63 | −0,84% | 48 |
| 150–240 perc | −0,128% | −1,51 | −0,48% | 45 |
| 240–330 perc | −0,368% | −3,05 | −0,95% | 34 |
| 300–390 perc | −0,309% | −2,54 | −0,70% | 27 |

Egyetlen pozitív szakasz van: a **nyitás első fél órája**. A 90. perc után minden szakasz
negatív, és a délután erősebben negatív, mint amilyen erősen a reggel pozitív. A jelenlegi
éles stratégia +1,08%-a tehát nem egyenletesen keletkezik: a reggel megtermeli, a délután
nagyrészt visszaadja.

Ellenpróba ugyanebben a táblában: az **azonos szélességű**, de máshova helyezett ablak
(`tod-30-120`, 90 perc, +0,30%) sokkal rosszabb. Nem a „kevesebb trade" magyarázza, hanem
a **napszak**.

## 4. Két kontroll-kísérlet

Egy külső, ellenséges kód-review két alternatív magyarázatot vetett fel a fenti
eredményre. Mindkettőt megmértük.

### 4a. Placebo: mit ad a JEL, és mit ad pusztán a napszak?

Az `always` kontroll-alak jel nélkül lép be (mindig igaz, ha van szabad hely). Ha a
reggeli ablak ezzel is ugyanannyit hoz, akkor a jel nem ad semmit.

| ablak | JELLEL (átlag/trade) | JEL NÉLKÜL (átlag/trade) | a jel hozzáadott értéke |
|---|---|---|---|
| 0–30 perc | +0,215% | +0,056% | **~4×** |
| egész nap | +0,106% | +0,053% | ~2× |
| 240–330 perc | **−0,368%** | −0,164% | **rosszabbá teszi** |

A jel tehát valódi: a reggeli ablakban megnégyszerezi a várható értéket. **És a délután
nem egyszerűen gyenge, hanem a jel ott ANTI-PREDIKTÍV**: kitörésre venni délután
rosszabb, mint véletlenszerűen venni délután. A momentum a nap második felében
visszafordul.

### 4b. Költség: a szűrő előnye a jelből jön, vagy csak a kevesebb kereskedésből?

A modell fél spreadet (2,5 bp) és slippage-et (5 bp) számol oldalanként, azaz **15 bp
körönként**. 10%-os tétellel ez 0,015% egyenleg körönként, tehát a `breakout` (98 kör) és
a `tod-60` (69 kör) közti 29 kör önmagában 0,435%-ot magyarázna a mért 0,47%-ból.

Költség nélküli kontroll-futás:

| alak | költséggel | költség NÉLKÜL | átlag/trade (költség nélkül) | t |
|---|---|---|---|---|
| tod-60 | +1,55% | **+2,50%** | +0,382% | 2,73 |
| breakout | +1,08% | +2,37% | +0,256% | 2,42 |
| seg-0-30 | +1,32% | +2,09% | +0,365% | 2,33 |
| seg-90-150 | −0,84% | −0,23% | −0,057% | −0,73 |
| seg-240-330 | −0,95% | −0,55% | −0,219% | −1,81 |

Három dolog derül ki:

1. **A szűrő előnyének nagyjából 70%-a valóban költség-megtakarítás.** Költség nélkül a
   `tod-60` és a `breakout` közti különbség 0,47%-ról 0,13%-ra esik.
2. **De a jel-minőség különbsége valódi:** trade-enként +0,382% vs +0,256%, azaz a reggeli
   belépő bruttó is ~50%-kal jobb. A teljes hozam azért nem tér el jobban, mert a szűrő
   kevesebb trade-et enged.
3. **A költség-feltevés sorsdöntő.** A bruttó él ~2,4–2,5% / 60 nap, amiből a modellezett
   15 bp körülbelül a felét eszi meg. Ez a 15 bp egy **hard-code-olt becslés**, amit még a
   napi gyertyás korszakban választottunk. Likvid megacapeken marketable orderrel a valóság
   ennél olcsóbb lehet, és akkor a szűrő előnye kisebb.

## 5. Keresztmetszet: 30 papír

Ugyanez a verseny 30 likvid amerikai papíron (a 4 helyett), tört lottal:

| alak | 1. fél | 2. fél | teljes | maxDD |
|---|---|---|---|---|
| tod60+regime | −1,17% | +3,46% | **+2,28%** | 2,75% |
| tod-30 | −1,03% | +2,16% | +1,15% | 3,33% |
| regime-spy | −1,71% | +2,65% | +0,97% | 3,06% |
| tod-60 | −1,22% | +2,15% | +0,95% | 3,35% |
| breakout | −1,21% | +1,82% | +0,83% | 3,36% |
| orb15 | −3,32% | +2,73% | −0,81% | 3,83% |
| vwap-cross | −3,99% | −1,83% | −5,84% | 6,97% |
| pullback | −4,58% | −1,67% | −6,23% | 6,64% |

Két külön tanulság:

- **A SORREND replikálódik** egy teljesen más keresztmetszeten: a napszak- és rezsim-szűrő
  a 30 papíros univerzumon is a lista tetején van, a kitörés középen, az ORB / VWAP /
  mean reversion alul. Ez erős érv amellett, hogy a napszak-hatás nem a 4 kiválasztott
  papír szerencséje.
- **De az ABSZOLÚT teljesítmény sokkal rosszabb**, és 30 papíron **semmi nem robusztus**
  (mindegyik variáns első fele negatív), a drawdown pedig 0,7-0,9%-ról 2,8-3,4%-ra ugrik.
  Ez megerősíti a korábbi szélesség-mérést: **maradunk a 4 papírnál.**

## 6. „Gyorsabb" — a sebesség dimenziója

| kérdés | mérés | válasz |
|---|---|---|
| Kisebb gyertya jobb-e? | 15 perces: minden alak a harmadára esik (legjobb +0,52% a +1,55% helyett), a sorrend viszont ugyanaz | **az 5 perc marad** |
| Az 1 perces gyertya? | a Yahoo csak 7 napot ad → 4 használható ülés, 4–6 trade | **nem mérhető**, ezért nem is állítjuk |
| Gyakoribb döntés? | minden eddigi mérés ugyanazt mondja: szűkebb stop, több papír, egész napos belépő, gyorsabb jel — mind ROSSZABB | **a gyorsabb NEM jobb** |
| Adat-késleltetés | Yahoo `regularMarketTime` ülés alatt 28–35 mp | bőven elég az 5 perces ciklushoz |

A „leggyorsabb" és a „legjobb" itt **ellentétes irányba mutat**. Ennek a stratégiának a
javítási iránya nem a gyorsabb reagálás, hanem a **kevesebb és korábbi** kereskedés.

Mellékesen kiderült, hogy az 1 perces lekérés eddig **mindig hibára futott**: a
`rangeForBars` 60 napot kért rá, amit a Yahoo `Unprocessable Entity`-vel utasít el.
Javítva (a perces sorozat maximuma 7 nap), teszttel.

## 7. Az ajánlás

**A legjobb mért konfiguráció: a jelenlegi kitörés-jel + belépő CSAK az ülés első 60
percében + SPY rezsim-szűrő** (`tod60+regime`).

| | jelenleg éles | ajánlott |
|---|---|---|
| hozam / 60 nap | +1,08% | **+1,56%** |
| max visszaesés | 0,81% | **0,68%** |
| találati arány | 55% | **65%** |
| trade | 98 | 55 |
| átlag/trade | +0,106% | **+0,306%** |

**Amit ez NEM jelent:**

- **Nincs statisztikai bizonyíték.** t = 2,08, miközben 22 variánst mértünk ugyanazon a 60
  napon; többszörös összehasonlításra korrigálva ez nem szignifikáns. Ami meggyőző, az nem
  egyetlen cella, hanem a **monoton szerkezet** (az átlag/trade folyamatosan romlik, ahogy
  a belépő-ablak szélesedik) és a **placebo-kontraszt**.
- **A 60 nap rövid és emelkedő piac.** Ugyanebben az ablakban a puszta tartás SPY +5,9%,
  MSFT +27,7%. Ez a sáv nem veri a vételt-és-tartást; amit ad, az a 0,7%-os drawdown és a
  nulla overnight kockázat.
- **A költség-modell sorsdöntő és becsült.** Lásd 4b.

### Hogyan kapcsolható be

A cserélhető belépő bekötve, de **alapból KI**: env-változó nélkül a beépített kitörés-jel
dönt, tehát az éles viselkedés magától nem változik.

```
STOCK_INTRADAY_ENTRY_SHAPE=tod60+regime
```

Ismeretlen név esetén a ciklus **nem** kapcsol ki minden belépőt, hanem naplóz egy
figyelmeztetést és a beépített jelnél marad. A használt alak neve megjelenik a ciklus
eredményében (`entryShape`).

Újramérés:

```
pnpm tsx scripts/stock-intraday-backtest.ts --sweep shape                    # a teljes névtár
pnpm tsx scripts/stock-intraday-backtest.ts --sweep shape --shape tod-60     # egy alak
pnpm tsx scripts/stock-intraday-backtest.ts --sweep shape --nocost           # költség nélkül
pnpm tsx scripts/stock-intraday-backtest.ts --sweep shape --wide --fractional
```

## 8. Amit az ellenreview talált (és javítva lett)

Egy friss szemű, ellenséges kód-review 16 kifogást emelt. A kettő legsúlyosabbat
leellenőriztük az adaton, és **nem álltak meg a mért futásra**:

| vád | ellenőrzés | ítélet |
|---|---|---|
| Index-alapú összefésülés = look-ahead, ha bármelyik papírból hiányzik egy bar | a 4 papíros gyorsítótár 4681 barján és a 30 papíroson: **0 elcsúszás** | a mérés tiszta; a csapda viszont valós → **`assertAligned` kapu**, ami leáll elcsúszásnál |
| Csonka záró ülés → be nem zárt pozíció piaci áron könyvelve | core: utolsó nap 79 bar (teljes); wide: 5 bar (**csonka**) | a core mérés ép; a csonka záró ülést mostantól **eldobjuk** |

Valódi hibák, amiket a review talált és javítottunk:

1. **Fél-napos tőzsdei ülések** (`US_MARKET_HALF_DAYS`). 2026-11-27 és 2026-12-24 13:00 ET-kor
   zár. Eddig a bot 16:00-ig `trading` fázisban maradt volna: **elavult áron nyitott volna
   pozíciót zárt piacra, és a laposra zárás három órával a valódi záró UTÁN futott volna** —
   vagyis a day-trading pozíció bent ragad éjszakára. Ez éles üzemi hiba volt, nem
   mérés-technikai.
2. **`etParts` UTC-fallback.** Váratlan `Intl`-kimenetnél a UTC-hétköznapra esett vissza;
   ET vasárnap 20:00 UTC-ben már hétfő, tehát a hétvégéből kereskedési nap lett volna.
   Most az ET dátumból számol.
3. **Rezsim-szűrő néma fail-open.** Rövid vagy hiányos benchmark-soron az `sma` a meglévő
   elemekre átlagolt, így a feltétel `x >= x` lett, azaz **igaz** — egy csonka SPY-sor az
   egész univerzumnak zöld utat adott. Most rövid sorra nincs engedély.
4. **ORB: egy ülésen kívüli bar kioltotta az egész napot.** A `m === null` és a
   `m >= orMinutes` ugyanazon a `break`-en osztozott, így egy záró print a nap ORB-ját
   csendben letiltotta.
5. **`allOf()` üres listára `true`-t adott** (fail-open kombinátor). Most dob.
6. **Yahoo 1 perces lekérés mindig hibára futott** (60 napot kért 7 helyett).
7. **Teljesítmény:** az `etParts` gyertyánként többször hívta az `Intl`-t; egy 30 papíros
   sweep több tízmillió hívást csinált. Perc-vödrös memoizálás (a UTC-perc pontosan egy
   ET-percre képződik, tehát az eredmény nem változik).

Amit a review felvetett, de **nem** javítottunk (tudatos, dokumentált maradék):

- **A szimbólum-választás a jeltől független.** Egy cikluson legfeljebb egy momentum-vétel
  születik, és a jogosultak közül a legnagyobb utolsó-bar mozgású papír nyer. Egy alak,
  ami 1 papírt jelöl meg, és egy, ami 25-öt, ugyanannyi belépőt kap. Ez főleg a **széles,
  tartós** jeleket (VWAP-trend) torzítja, mert náluk a mért dolog valójában „vedd a
  legnagyobb 5 perces mozgót". A napszak-eredményt nem érinti, mert ott ugyanaz a
  szabály fut minden ablakban.
- **A maxDD alulbecsült**: gyertya-záró alapon, a bar saját kötései előtti egyenlegből
  számol, tehát egy baron belüli stop-out nulla visszaesésként látszik.
- **A gyorsítótárban nincs eredet-jelölés** (mikor és milyen univerzummal készült).
- **PDT-szabály** valós számlán: 25 000 USD alatt heti 3 kör-kereskedés. A paper sáv ezt
  nem modellezi, és a 4 papíros konfiguráció napi ~1 körrel bőven a limit fölött lenne.

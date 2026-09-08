# Részvény day trading — mérés, felépítés, üzemeltetés

**Dátum:** 2026-09-08 · **Mód:** paper · **Sáv:** `stock-paper` (USD)

A részvény-sáv napi (swing) ritmusról **day tradingre** váltott: az amerikai ülés alatt
5 percenként dönt, és a nap végén laposra zár. Ez a dokumentum azt írja le, hogy mit
mértünk, mi lett a beállítás, és mi hajtja élesben.

## 1. Amit a mérés mondott

Eszköz: `scripts/stock-intraday-backtest.ts`. Nem külön szimulátor — a **live utat**
futtatja történelmi gyertyákon: ugyanaz a döntés-agy (`planStockCycle`), ugyanaz a
végrehajtás (`runStockCycle` → risk-manager + PaperExecutionBroker + egész részvény lot +
díj/spread), ugyanazok az ülés-fázisok. Adat: Yahoo 5 perces gyertya, 60 nap
(2026-06-11 → 2026-09-04), AAPL/MSFT/NVDA/SPY, 4681 bar/szimbólum.

### Szűk stop / take-profit (5 perces gyertya)

| variáns | hozam 60 nap | trade | win | maxDD |
|---|---|---|---|---|
| stop 1,00% / TP 1,50% | **−2,73%** | 226 | 35% | 3,10% |
| stop 0,75% / TP 1,00% | −3,67% | 279 | 32% | 3,73% |
| stop 0,50% / TP 0,75% | −4,76% | 339 | 29% | 4,83% |
| stop 0,30% / TP 0,50% | **−6,57%** | 437 | 26% | 6,62% |

**Mind a 16 variáns veszített**, és monoton romlik, ahogy a stop szűkül és a trade-szám
nő. Ugyanez az ATR-trailingre: x3 → −1,28%, x2 → −2,77%, x1,5 → −3,64%, x1 → −4,96%.
A tanulság ugyanaz, mint a korábbi kripto-scalp mérésé: a zaj kirázza a szűk stopot, a
gyakori kereskedés pedig a költségen bukik.

### Ami pozitív: kitörésre belépő + nap végi zárás

| variáns (stop 5% / TP 10%) | hozam | trade | win | maxDD | 1. fél | 2. fél |
|---|---|---|---|---|---|---|
| SMA 78 / lookback 156 | **+1,08%** | 98 | 55% | **0,81%** | +0,39% | +0,68% |
| SMA 24 / lookback 48 | +0,87% | 155 | 48% | 1,16% | +0,59% | +0,29% |
| SMA 39 / lookback 78 | +0,83% | 132 | 46% | 1,00% | +0,50% | +0,36% |
| SMA 12 / lookback 24 | +0,64% | 179 | 46% | 1,79% | — | — |

Mindhárom vizsgált variáns **a 60 nap mindkét felén pozitív** (ez a repó „robust"
kritériuma), tehát nem egyetlen szerencsés ablak. A nyertes a leglassabb jel.

15 perces gyertyán ugyanez gyengébb (legjobb: +0,40%), ezért maradt az 5 perces.

### Az őszinte keret

Ugyanebben a 60 napban a **puszta tartás**: SPY +5,90%, AAPL +9,83%, NVDA +14,21%,
MSFT +27,69%. A day-trading sáv **nem veri a vételt-és-tartást** egy emelkedő piacon.
Amit ad: **0,81% maximális visszaesés** és **nulla overnight kockázat** (minden pozíció
zárul a csengetés előtt). Ez kockázat-profil, nem hozam-ígéret.

## 2. A beállítás (STOCK_INTRADAY_STRATEGY)

| paraméter | érték | miért |
|---|---|---|
| gyertya | 5 perc | mérve jobb, mint a 15 perc |
| belépő | momentum-breakout, SMA 78 / lookback 156 bar (≈1, illetve 2 ülés) | a leglassabb jel nyert |
| tétel | equity 10%-a | egész részvény lot mellett a 2% 0 darab SPY-t jelentene |
| stop | 5% (katasztrófa-stop) | minden szűkebb stop veszített |
| take-profit | 10% | intraday gyakorlatilag nem sül el; a kilépés a nap végi zárás |
| max pozíció / egyidejű | 20% / 3 | változatlan kockázati keret |
| belépő-stop | zárás előtt 30 perc | ami nem érne célba, azt ne nyissuk |
| laposra zárás | zárás előtt 10 perc | a day trading lényege |

A nap végi zárás saját `eod-flat` origin-t kap, hogy az analitika ne keverje a
take-profittal.

## 3. Mi hajtja élesben

A projektnek **egyetlen 5 perces külső időzítője** van (ez hívja a `/api/cron/exit`
végpontot, és élesben megbízhatóan fut). Ezért a részvény-ciklus ugyanarra a triggerre
került: a route **két független ciklust** indít — a kripto gyors kilépést és a részvény
day tradinget. Külön lease, külön hiba-ág: az egyik bukása nem viszi el a másikat.

```
külső cron (5 perc) → POST /api/cron/exit
                        ├── executeScheduledExit()            (kripto stop/TP/trailing)
                        └── executeScheduledStockIntraday()   (részvény day trading)
```

- Zárt piacon a részvény-ciklus azonnal kilép (`session:pre-market` / `weekend` / …),
  tehát a hívás olcsó.
- Lease: `stock-intraday:<5 perces slot>`, TTL 4,5 perc — ugyanabban a sávban egy ciklus
  fut, a következő sáv szabad. Az intent-azonosító a slotot hordozza, tehát nem ütközik.
- Kézi indítás: `pnpm tsx scripts/stock-intraday.ts [--force]` vagy
  `POST /api/cron/stock-intraday?force=1` (CRON_SECRET-tel).
- A napi swing workflow (`daily-stock-tick`) **ütemezése kikapcsolva**, mert ugyanabba a
  pénztárcába könyvelne. Kézzel (`workflow_dispatch`) továbbra is indítható.

## 3b. API-k: mit mértünk, és mi maradt bent (2026-09-08 este)

Három kulcs került be (Alpaca paper, Finnhub, Alpha Vantage). A kérdés az volt, hogy
gyorsítanak vagy profitot hoznak-e. A válasz **mérve**, nem elvben:

| irány | mérés | döntés |
|---|---|---|
| **Yahoo késleltetés** | ülés alatt mérve **28-35 másodperc** (`regularMarketTime` vs. óra) | fizetős real-time adat FELESLEGES |
| **Alpaca ingyenes adat** | csak **IEX**-tape: nyitás előtt hiányzó barok, a bar-alak nem konszolidált | a gyertya marad a Yahoo-nál |
| **Tört részvény (Alpaca `fractionable`)** | 60 nap: tört 10%/3 poz **+1,04%** vs egész lot 10%/3 **+1,08%** → zaj. A tétel-méret viszont lineárisan skáláz (2% → +0,18%, 20% → +1,83%, a maxDD ugyanígy) — tehát ez **tőkeáttétel, nem edge** | **BE**: a kerekítés egy adat-korlát maradványa volt, a pontos méretezés hűbb a stratégiához |
| **Szélesebb univerzum (4 → 30 papír)** | 10%/3 poz: **+0,83%** (maxDD 3,36%) a 4 papíros +1,08% (maxDD 0,81%) helyett; több egyidejű pozícióval **negatív** (−0,52% … −3,05%) | **NEM adoptálva** — a szélesség itt rontott. A 30-as lista a backteszt-szkriptben marad (`--wide`) |
| **Gyorsjelentés-tiltás (Finnhub)** | +0,81% vs +1,08% tiltás nélkül, ugyanannyi trade | **env-kapcsolóra** (`STOCK_EARNINGS_BLACKOUT=1`), alapból KI |
| **Hír/szentiment (Alpha Vantage)** | nem mértük; ingyenes szint napi 25 hívás | **nincs használatban** |

Ezen felül bekerült egy **adat-integritás kapu** (`detectPriceAnomaly`): ha két egymást
követő gyertya záróára között hihetetlen ugrás van (intraday >20%, napi >45%), az egész
sorozat gyanús → az instrumentum kimarad a ciklusból. A korábbi „split = hamis −75%"
félelem egyébként **alaptalan volt**: ellenőrizve, a Yahoo visszamenőleg split-korrigál
(NVDA 2024-06-03 záró 115, nem 1150).

**A tanulság ugyanaz, mint a stop/TP rácsnál:** ennek a stratégiának a szűk keresztmetszete
nem az adat sebessége és nem a papírok száma. Egyik megvásárolható API sem javított rajta.

## 4. Ami nyitva maradt

- **A mérés 60 napja rövid és emelkedő piac.** Eső vagy oldalazó rezsimben más lehet;
  a Yahoo intraday nem ad 60 napnál régebbi adatot, ezért ennél hosszabb visszamérés
  ezen a forráson nem lehetséges.
- **PDT-szabály:** valódi (nem paper) számlán az amerikai day trading 25 000 USD alatt
  heti 3 kör-kereskedésre korlátozott. A paper sáv ezt nem modellezi.
- **Adat-késleltetés: MÉRVE, rendben.** Ülés alatt a Yahoo `regularMarketTime` 28-35
  másodperccel van a jelen mögött, tehát az 5 perces ciklushoz bőven friss.
- **A napi swing ág kódja megmaradt** (tesztelt, kézzel indítható), de nem fut.

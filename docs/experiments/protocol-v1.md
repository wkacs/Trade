# Profitkísérleti protokoll v1 (T29)

**Protokoll-verzió:** `exp-v1-2026-09-05` · **hash:** `0a2098c3`
**Stratégia-verzió:** `v2-2026-09-05`
**Gépi forma:** [`scripts/experiment-configs.ts`](../../scripts/experiment-configs.ts)

Ez a dokumentum azt rögzíti, **mit mérünk, milyen adaton, milyen költség mellett, és
mikor mondjuk azt, hogy egy jelölt jobb**. Mindezt a mérések **előtt**.

> A hash a fagyasztott döntések ujjlenyomata. Ha bárki utólag hozzányúl egy küszöbhöz,
> egy változathoz vagy egy költségfeltevéshez, a hash elmozdul — a régi jelentés
> ezután nem állítható be az új protokoll eredményének.
> Kiíratás: `pnpm tsx scripts/experiment-configs.ts`

---

## 0. Miért van erre szükség

Az audit (§8) szerint a korábbi „tournament" **a teszt-ablakon** választott nyertest,
és az elfogadási küszöb utólag igazodott a látott eredményhez. Így minden mérés
önigazoló lett: a nyertes azért nyert, mert őt választottuk arra az adatra.

Ez a protokoll három ponton zárja el ezt az utat:

1. a **holdout** el sem jut a jelöltválasztáshoz (a `selectCandidate` csak a fejlesztési
   szeleteket kapja meg),
2. a **kockázati és költségkeret** a mérés előtt fagy be, és a hozam nem írja felül,
3. a **változatok csak a vizsgált paraméterben** térhetnek el — ezt gép ellenőrzi.

---

## 1. Amit előre befagyasztunk

### 1.1 Kockázati és költségkeret

| Keret | Érték | Mit jelent |
|---|---|---|
| Max lehúzás | **25%** | Efölött a jelölt **elutasított**, bármilyen hozam mellett |
| Költségkeret | **a záró tőke 3%-a** | Díj + slippage összesen. Efölött a stratégia a brókert gazdagítja |
| Max kitettség | **90%** | Ennél többet piacban tölteni már nem „stratégia", hanem buy & hold |
| Min. lezárt kötés | **30** | Ez alatt az eredmény **nem eldönthető** — se siker, se bukás |
| Min. többlet a vak alapvonalhoz | **2 százalékpont** | Ennél kisebb eltérés zaj |

A 25%-os lehúzás **tűréshatár, nem célérték**, a jelenlegi 100 USD-s papírtőkére. A 3%-os
költségkeret a mai 0.1%-os díj mellett nagyjából 30 teljes körfordulónak felel meg.

### 1.2 Adatablak és felosztás

| Paraméter | Érték |
|---|---|
| Eszközök | BTC, ETH, SOL |
| Gyertya | 1 óra, **lezárt** |
| Kért történet | 365 nap (a ténylegesen elérhetőt a `dataHash` rögzíti) |
| Holdout | a **legfrissebb 20%**, zárolva, **egyszeri** mérés |
| Gördülő felosztás (fejlesztési rész) | 60 nap tanulás / 20 nap validáció, 20 napos lépés |
| Szeletenkénti min. kötés | 3 (ez alatt a jelölt nem rangsorolható) |

A holdouton **nem rangsorolunk**. Az `evaluateOnHoldout` nem is kap jelöltlistát, tehát
nem tud. Egy jelölt egyszer mérhető rajta; a „nézzük meg a másodikat is" **új
protokollt** igényel, új holdouttal.

### 1.3 Költség- és tőkeforgatókönyvek

| Forgatókönyv | Díj | Slippage | Min. kötés |
|---|---|---|---|
| alap | 0.10% | 5 bps | 5 USD |
| emelt | 0.15% | 25 bps | 5 USD |

| Tőke | Miért |
|---|---|
| 100 USD | a tényleges papírtőke |
| 10 000 USD | kontroll: itt a minimum notional nem szorít. Ha egy stratégia csak itt működik, azt ki kell mondani |

### 1.4 Kilépési ütem

A kilépés-ciklus vizsgált sűrűségei: **1 / 5 / 15 / 60 perc**. Ez **izolált** vizsgálat:
a négy változatnak **azonos a belépési intentje**, csak a kilépés-ellenőrzés sűrűsége
tér el. Különben nem tudnánk, a különbség a gyorsabb kilépésből vagy más belépésekből jött.

---

## 2. Kísérletek

Egy kísérlet **egy kérdést** vizsgál. A `baseline` mindenhol pontosan a futó éles
stratégia (`DEFAULT_STRATEGY`), hogy az összehasonlítás azonos motorral, azonos adaton,
azonos könyveléssel történjen.

| Id | Kérdés | Tengely | Változatok |
|---|---|---|---|
| `E1-dca-threshold` | A félelem-kapu szigorítása vagy lazítása javít-e a DCA nettó eredményén? | `dcaFgThreshold` | FG ≤ 20 (alap), 15, 25, 30 |
| `E2-momentum` | Hozzáad-e a momentum-belépő a DCA-alapvonalhoz azonos kockázati kereten belül? | `momentumEnabled` | ki (alap), be |
| `E3-take-profit` | Teljes vagy részleges realizálás ad jobb kockázat-hozam arányt? | `takeProfitPct`, `takeProfitFraction` | +10%/teljes (alap), +15%/fél, +7%/teljes |
| `E4-entry-filter` | A trend-szűrő javít, vagy csak belépéseket hagy ki? | `entryFilter` | be (alap), ki |
| `E5-stop-mode` | Az ATR-stop jobb-e a fix −5%-nál, kockázatnövelés nélkül? | `stopMode`, `atrMult` | fix (alap), ATR×2, ATR×3 |

**A jelenlegi kísérletek egyike sem emel kockázatot.** A `validateExperiment()` minden
változatra ellenőrzi, hogy a pozícióméret, az egyidejű pozíciók száma, a stop távolsága,
a DCA-keret, a napi veszteségtűrés és a trade-kockázat **nem lazul** az éleshez képest.
Ha egy jövőbeli változat mégis lazít, azt `raisesRisk: true`-val **kötelező** jelölni, és
ilyen változat **felhasználói kockázatdöntés nélkül nem adoptálható**.

### Kontrollok (nem jelöltek)

| Id | Mi ez |
|---|---|
| `cash` | készpénz: nem csinálunk semmit |
| `buy-and-hold` | egyenlő súlyú vétel és tartás |
| `ai-free` | ugyanaz a kód, LLM-döntés nélkül |

Ezek nélkül egy pozitív hozam nem jelent semmit: emelkedő piacon a buy & hold szinte
minden aktív stratégiát ver, és ha a bot alatta marad, az akkor is bukás, ha a
sorszám zöld.

---

## 3. Elfogadási szabály

A sorrend számít, és **a hozam a legutolsó**:

1. **Kevés kötés** (< 30 lezárt) → **NEM ELDÖNTHETŐ.** Nem siker és nem bukás; a mérés
   nyitva marad.
2. **Keretsértés** (lehúzás, költség vagy kitettség) → **ELUTASÍTVA**, bármilyen hozam mellett.
3. **A vak alapvonal felülmúlása** legalább 2 százalékponttal → **elfogadható jelölt**.

```
verdict = evaluateAcceptance({ netReturnPct, maxDrawdownPct, exposurePct,
                               closedTrades, totalFeesUsd, finalEquityUsd,
                               baselineReturnPct })
```

**„Elfogadható jelölt" ≠ „bekapcsolva".** Az adoptálás külön, felhasználói
kockázatdöntés. Amíg az nincs meg, a futó rendszer a javított DCA-alapvonal marad —
és ez **érvényes kimenet**, nem kudarc.

### Amit tilos

- Küszöböt mozgatni azért, mert a jelölt épp alatta maradt.
- A holdoutot „még egyszer" megnézni másik jelölttel.
- Egy változatot úgy javítani, hogy közben egy másik paraméter is elmozdul.
- Sikertelen variánst kihagyni a jelentésből. **A bukott mérés is eredmény**, és
  bekerül a `results-v1.md`-be.

---

## 4. Hogyan indítható újra a mérés

```bash
# 1) A fagyasztott protokoll kiírása (a jelentés fejlécébe)
pnpm tsx scripts/experiment-configs.ts

# 2) Összehasonlító mérés (T30) — minden kísérlet, minden költség- és tőke-forgatókönyv
pnpm tsx scripts/compare-strategies.ts

# 3) A protokoll érvényessége tesztként
pnpm exec vitest run tests/lib/backtest/experiment-configs.test.ts
```

Minden jelentés fejlécében szerepel: a protokoll-hash, a stratégia-verzió, a
fejlesztési és a holdout **adat-hash**, a költségfeltevés és a végrehajtási modell.
**Két azonos hashű futásnak azonos jelentést kell adnia** — ha nem, a mérés nem
reprodukálható, és az eredmény nem használható.

---

## 5. Ismert korlátok

- **Három eszköz, egy piaci rendszer.** A 365 nap egyetlen makro-rezsimet fed le. Egy
  itt nyerő jelölt más rezsimben veszíthet.
- **A korrelált kötések miatt a 30 lezárt kötés nem statisztikai garancia**, csak alsó
  korlát a nyilvánvaló zaj kiszűrésére. Három eszköz együtt mozog: a „független minta"
  fogalma itt gyenge.
- **A backteszt fill-modellje közelítés.** A `polling` modell a bot valóságát írja le
  (időnkénti pillanatkép, következő nyitón teljesülő order); az `exchange-stop` a
  tőzsdén ülő védőordert. A kettő eltérő eredményt ad, és **mindkettőt jelentjük** —
  a kedvezőbb kiválasztása önbecsapás lenne.
- **Az AI-ág visszajátszása korlátozott.** A rögzített döntéseket játsszuk vissza, nem
  futtatjuk újra a mai LLM-et a régi híreken. Ahol nincs rögzített döntés, ott az
  AI-ág **nem mérhető**, és ezt a jelentés kimondja.

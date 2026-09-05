# Előremenő paper összevetés v1 (T31)

Ez a mérés nem múltbeli optimalizálás. A baseline és egy előre rögzített jelölt azonos
piaci pillanatképben fut, külön paper ledgeren. A cél az, hogy az elméleti backtest után
kiderüljön: a fillmodell, a költség és a valós adatfolyam mellett is van-e mérhető különbség.

## Amit a futtató garantál

- minden számla `paper`, egyedi `portfolioId`-val;
- azonos induló tőke minden számlán;
- a baseline gyűjti be egyszer a quote-ot és a collector-kimenetet, a jelölt ezt kapja replayben;
- az árnyékszámla nem ír a régi dashboard-portfólióba;
- alapból AI nélküli kontrollt futtat; `--ai` mellett a baseline egyetlen nyers AI-döntése
  változatlan replayként kerül a jelölthöz;
- a provisionált protokoll hashét, a ciklusokat, ciklusonkénti equityt és adatincidenst
  tartósan tárolja; eltérő protokollal ugyanaz a namespace nem folytatható.

## Indítás külön paper adatbázisban

Előbb a v2 séma legyen egy külön, papír célú PostgreSQL adatbázisban, majd:

```powershell
$env:DATABASE_URL = "postgres://...külön-shadow-paper-adatbázis..."
pnpm shadow:paper -- --check
pnpm shadow:paper -- --provision
pnpm shadow:paper -- --once
pnpm shadow:paper -- --report
```

Az alapértelmezett pár az `E5-stop-mode` baseline és `atr2`. Más előre rögzített pár:

```powershell
pnpm shadow:paper -- --experiment E2-momentum --candidate momentum-on --namespace shadow-e2 --provision
pnpm shadow:paper -- --experiment E2-momentum --candidate momentum-on --namespace shadow-e2 --once
```

Az `--once` explicit egyszeri ciklus. A rendszer jelenleg nem aktív, mert a GitHub Actions
kerete kifogyott; a számlák provisionálása önmagában nem indít ütemezőt. Indításkor egyetlen,
megbízható külső ütemező hívhatja ezt az egyszeri parancsot, és csak a külön shadow adatbázisban.
Az `--once` minden futás végén ugyanazt a tartós riportot írja ki, amely külön `--report`
kapcsolóval is lekérhető. A riport equityt, nettó hozamot, max drawdownt, USDT-díjat,
lezárt round-tripet, ciklusszámot és degradált ciklust mutat.

## Döntési szabály

A mérés minimuma **30 naptári nap és 50 lezárt round-trip** a baseline-on. Mindkettő kell.
Kevesebb adat, eltérő futási ciklusszám, adatkimaradás vagy egyoldalú piac esetén az eredmény
`open`: ez nem győzelem, és nem stratégiaátállási alap.

A végső jelentésben számlánként szerepelnie kell a díjak utáni hozamnak, max drawdownnak,
költségnek, ciklusszámnak, incidenseknek és kötésenkénti bizonytalansági intervallumnak. A
korrelált kötések és közös piaci rezsimek miatt a cél teljesítése sem jelent statisztikai vagy
jövőbeli profitgaranciát. A protokoll hashét a `pnpm tsx scripts/experiment-configs.ts` rögzíti.

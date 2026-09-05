# Előremenő paper összevetés v1 (T31)

Ez a mérés nem múltbeli optimalizálás. A baseline és egy előre rögzített jelölt azonos
piaci pillanatképben fut, külön paper ledgeren. A cél az, hogy az elméleti backtest után
kiderüljön: a fillmodell, a költség és a valós adatfolyam mellett is van-e mérhető különbség.

## Amit a futtató garantál

- minden számla `paper`, egyedi `portfolioId`-val;
- azonos induló tőke minden számlán;
- a baseline gyűjti be egyszer a quote-ot és a collector-kimenetet, a jelölt ezt kapja replayben;
- az árnyékszámla nem ír a régi dashboard-portfólióba;
- AI nélküli kontrollt futtat. AI-s összevetéshez ugyanazt az előre naplózott AI-döntést kell
  minden párra replayelni; külön AI-hívás számlánként már eltérő bemenet lenne.

## Indítás külön paper adatbázisban

Előbb a v2 séma legyen egy külön, papír célú PostgreSQL adatbázisban, majd:

```powershell
$env:DATABASE_URL = "postgres://...külön-shadow-paper-adatbázis..."
pnpm shadow:paper -- --check
pnpm shadow:paper -- --provision
pnpm shadow:paper -- --once
```

Az alapértelmezett pár az `E5-stop-mode` baseline és `atr2`. Más előre rögzített pár:

```powershell
pnpm shadow:paper -- --experiment E2-momentum --candidate momentum-on --namespace shadow-e2 --provision
pnpm shadow:paper -- --experiment E2-momentum --candidate momentum-on --namespace shadow-e2 --once
```

Az `--once` explicit egyszeri ciklus. A rendszer jelenleg nem aktív, mert a GitHub Actions
kerete kifogyott; a számlák provisionálása önmagában nem indít ütemezőt. Indításkor egyetlen,
megbízható külső ütemező hívhatja ezt az egyszeri parancsot, és csak a külön shadow adatbázisban.

## Döntési szabály

A mérés minimuma **30 naptári nap és 50 lezárt round-trip** a baseline-on. Mindkettő kell.
Kevesebb adat, eltérő futási ciklusszám, adatkimaradás vagy egyoldalú piac esetén az eredmény
`open`: ez nem győzelem, és nem stratégiaátállási alap.

A végső jelentésben számlánként szerepelnie kell a díjak utáni hozamnak, max drawdownnak,
költségnek, ciklusszámnak, incidenseknek és kötésenkénti bizonytalansági intervallumnak. A
korrelált kötések és közös piaci rezsimek miatt a cél teljesítése sem jelent statisztikai vagy
jövőbeli profitgaranciát. A protokoll hashét a `pnpm tsx scripts/experiment-configs.ts` rögzíti.

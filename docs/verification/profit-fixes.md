# Profitjavítások — visszaellenőrzés (T32)

**Állapot:** a forráskód-javítások és az automatizált regressziós készlet elkészült.
Ez nem profitígéret és nem live engedély. A megfigyelési, tesztkörnyezeti és üzemeltetési
kapuk külön maradnak nyitva, amíg ténylegesen le nem futnak.

## Auditmegállapítások és a beépített védelem

| Audit-terület | Javítás | Forrásbeli bizonyíték |
|---|---|---|
| Régi, bizonytalan demoállapot | verziózott legacy-import és külön ledger-epoch | T01, T11; `legacy-import.ts`, `ledger-contract.md` |
| Kétértelmű orderméret, cash-alapú SELL | v2 intent/fill szerződés: BUY quote-összeg, SELL base mennyiség | T02, `contracts.ts`, `execute-intent.ts` |
| DB-fallback, részleges írás, dupla tick | fail-closed DB, atomikus fill-könyvelés, lease/fencing és foglalások | T03, T09, T10 |
| Díj- és precision-drift | decimal ledger, fillenkénti közös reducer, nettó metrikák | T04, T05, T18 |
| Limit-, daily-loss-, DCA- és stop-drift | közös risk gate, napi equity referencia, heti DCA-keret, trailing szabály | T06–T08, T15 |
| Régi fixture visszaesése | külön legacy és v2 import/olvasási határ | T11 |
| Look-ahead, hiányos warmup, ATR/konfig eltérés | zárt gyertya, gapszűrés, közös signal/strategy konfiguráció | T12–T15 |
| AI-döntés visszamérése | valós portfólió-kontekstus, replayelhető értékelés, őszinte 1 órás cél | T16, T20 |
| Backtest és futó út eltérése | végrehajtási időzítés, részleges exit, benchmark és zárolt holdout | T17–T19 |
| Lassú kilépés és késő cron | LLM-mentes fast exit, állandó worker külön 5 perces/órás ciklussal | T21, T22 |
| Néma hiba és költségláthatatlanság | tick health, tartós futásállapot, deduplikált riasztás | T23 |
| Binance szabályok és order-életciklus | exchangeInfo filter, idempotens client ID/fill, védőorder és reconcile | T24–T27 |
| Action-korlát és nem reprodukálható mérés | egy aktív scheduler runbook, fagyasztott protokoll és összehasonlító runner | T28–T30 |
| Előremenő összevetés hiánya | elkülönített shadow paper ledger, baseline-input replay, 30 nap/50 round-trip küszöb | T31 |

## Cron trigger határ

`/api/cron/tick` ordert indíthat. A route ezért az `authorizeCronRequest` ellenőrzésén
megy át:

- `CRON_SECRET` meglétekor csak az azonos `Authorization: Bearer …` header engedélyezett;
- production vagy Vercel környezetben hiányzó secret **503-mal elutasítja** a kérést;
- autentikáció nélküli helyi teszt csak `ALLOW_UNAUTHENTICATED_LOCAL_CRON=true` és nem-hosted
  környezet mellett megy át.

Így a hiányzó hosted secret nem teszi publikussá a tick route-ot. A működő secret értéke nem
kerül logba vagy repóba; `.env.example` csak a változó szerepét dokumentálja.

## Automatikus ellenőrzés

A záráskor futtatandó parancsok:

```powershell
pnpm test
pnpm exec tsc --noEmit
pnpm build
pnpm shadow:paper -- --check
```

Az aktuális forrásellenőrzésen `pnpm test` **67 fájl / 756 teszttel zöld**,
`pnpm exec tsc --noEmit` zöld, és `pnpm build` zöld. A shadow konfigurációs parancs
az `E5-stop-mode` baseline/`atr2` párost, 100 USD-s, külön paper számlákkal érvényesnek
írja ki.

Az integrációs suite szándékosan külön fut: `TEST_DATABASE_URL` nélkül fail-closed, hogy ne
érinthessen normál adatbázist. A futtatási parancs `pnpm test:integration`; csak eldobható,
elkülönített PostgreSQL adatbázissal használható.

## Nyitott külső bizonyítékok

- A GitHub Actions keret kifogyása miatt nincs aktív előremenő futás. A worker/scheduler
  éles újraindítása nem történt meg.
- T31 akkor zárható le, ha az elkülönített shadow számlákon teljesül a 30 nap **és** 50
  round-trip, majd elkészül a költség-, drawdown-, incidens- és bizonytalansági jelentés.
- A PostgreSQL integrációs tesztekhez nincs itt `TEST_DATABASE_URL`; ezért order-recovery,
  protection-recovery, reconcile és shadow DB-folyamat nem kapott valódi DB-bizonyítékot.
- A 24 órás worker-próba, az 5 perces exit késleltetési cél és a desktop+mobil UI-kör nem
  futott le ebben a környezetben.
- Testnet és live Binance-próba nem történt. `TRADING_MODE` maradjon `paper`; a live váltás
  külön kockázati döntés és a fenti kapuk teljesülése után értékelhető.

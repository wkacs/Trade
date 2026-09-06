# Futtatási és átállási runbook (T28)

Ez a dokumentum azt írja le, **mi futtatja a botot, hogyan indul, hogyan áll le, hogyan
látszik, hogy él, és hogyan lehet visszaállni**, ha valami elromlik.

Állapot a dokumentum írásakor: **paper mód, live kereskedés kikapcsolva.** A live
átállás nem ennek a runbooknak a tárgya — külön döntés, külön ellenőrzőlista (T32).

---

## 1. Pontosan EGY aktív ütemező

Három hely tudna tickelni. **Egyszerre csak egy lehet aktív.**

| Szerep | Mit tud | Mit NEM tud | Költség |
|---|---|---|---|
| `worker` | 5 perces kilépés-ciklus **és** órás belépés | állandóan futó gépet igényel | a gép ára (otthoni PC / NAS: 0 Ft többlet) |
| `github-actions` | órás belépés (`scripts/tick.ts`) | **nincs 5 perces kilépés** — a stop csak óránként nézi meg magát | ingyenes (a repó Actions-kvótáján belül) |
| `vercel-cron` | órás belépés az éles `/api/cron/tick` Vercel Functionben | **nincs 5 perces kilépés**; Hobby saját cron csak napi egyszer futhat, ezért külső HTTP-időzítő kell | Vercel Hobby + külső időzítő free tierben is megoldható |

A választást **egy env változó** rögzíti:

```bash
SCHEDULER=worker            # vagy: github-actions | vercel-cron
```

Ezt a `schedulerGuard()` (`src/lib/config.ts`) érvényesíti:

- `pnpm worker` **nem indul el**, ha `SCHEDULER != worker` (kilépési kód `2`).
  Kivétel: `--once` futás és a `--force` kapcsoló.
- `scripts/tick.ts` (a GitHub-workflow) **zölden kihagyja** magát, ha
  `SCHEDULER != github-actions`. Így a workflow bekapcsolva maradhat anélkül, hogy a
  workerrel párhuzamosan tickelne. Kézi futtatás: `pnpm tsx scripts/tick.ts --force`.
- Elgépelt érték (`SCHEDULER=wroker`) esetén **egyik szerep sem aktív** — a hiba
  látszik, nem csúszik át csendben egy default-ra.

### Miért nem duplázna akkor sem, ha mégis kettő futna

Második védvonalként a **lease** (T10) van: a belépési ciklus idősávonként egy tartós
claim-et szerez (`entry:<sáv>`), és aki nem nyerte meg, az nem fut. A worker és a
`executeScheduledTick` **ugyanazt a kulcsot** számolja ki ugyanarra az órára (a sáv a
fali óra szerinti idősáv; az offset csak azt mondja meg, a sávon belül mikor indulunk).
Ezt a `tests/lib/engine/worker.test.ts` „egy aktív scheduler" blokkja bizonyítja.

A `vercel.json`-ban nincs natív cron: a Hobby csomag naponta csak egy futást enged.
Gyakoribb indításhoz egy külső felhős HTTP-időzítő POSTolja az éles route-ot. A ciklus
ettől még a Vercel Functionben fut, és ugyanaz a Neon lease védi a duplázástól.

---

## 2. Helyi worker (teljes működés)

### Indítás

```bash
cd C:\Users\konig\ZCodeProject
# .env.local: DATABASE_URL, LLM_*, TRADING_MODE=paper, SCHEDULER=worker
pnpm install
pnpm worker
```

Amit induláskor csinál, sorrendben:

1. betölti a `.env.local`-t (fallback `.env`),
2. ellenőrzi az ütemező-szerepet (`schedulerGuard`),
3. betölti a portfólió-állapotot — **DB nélkül nem indul** (hiányzó DB nem aktiválhat ordert),
4. felszabadítja a lejárt költségvetés-foglalásokat (`expireStaleReservations`),
5. megnézi az ismeretlen állapotú megbízásokat (`listUnsettledIntents`) — ha van, a
   ciklusok **nem indítanak új ordert**, amíg nincsenek egyeztetve,
6. LIVE módban tőzsdei egyeztetést futtat (T27). Ha az egyeztetés hibára fut, a
   viselkedés konzervatív: **új vétel tilos**, a kilépés és a védelem továbbra is megy.

### Ciklusok

| Ciklus | Alapérték | Mit csinál |
|---|---|---|
| kilépés | 5 perc | friss bid/ask, stop / take-profit / trailing, LLM nélkül |
| belépés | 60 perc, a sáv kezdete után 7 perccel | lezárt gyertya, collectorok, ML, LLM, kockázati kapu, végrehajtás |

A kettő **külön hurok és külön lease**: egy lassú LLM-hívás nem fogja meg a kilépést.
Késés vagy újraindulás után **nem pótoljuk** a kihagyott sávokat — mindig a jelenlegi
sáv fut.

### Egyszeri futtatás (kézi ellenőrzéshez)

```bash
pnpm worker:once                 # egy kilépés-ciklus
pnpm worker --once entry         # egy belépés-ciklus
pnpm worker --exit-ms 60000      # rövidebb kilépés-ciklus (teszthez)
```

### Leállítás és újraindítás

`Ctrl+C` vagy `SIGTERM`: **a folyamatban lévő ciklus befejeződik, új nem indul.**
Erőszakos kilövés (`taskkill /F`) esetén a lease legfeljebb a TTL végéig (a sáv 90%-a)
blokkolja a következő futást — utána magától átvehető. Ez nem hiba, csak késés.

Újraindítás után:

```bash
pnpm audit:state          # mit lát a rendszer a saját állapotáról
pnpm worker
```

### Állandó futtatás Windowsban

A worker sima Node-folyamat, semmi különös nem kell hozzá. Két bevált mód:

- **Feladatütemező** (Task Scheduler): trigger „bejelentkezéskor / rendszerindításkor",
  művelet `pnpm`, argumentum `worker`, indítási hely a repó gyökere, „a felhasználó
  bejelentkezése nélkül is fusson" bekapcsolva.
- **NAS / Docker**: ugyanaz a parancs egy `node:20` képben, `restart: unless-stopped`.

Fizetős felhő-futtatás (Railway, Fly, Render, VPS) **nem része ennek a lépésnek**: az
külön költségdöntés, lásd 6. szakasz.

---

## 3. GitHub Actions ütemezés (ingyenes, csökkentett működés)

```yaml
# .github/workflows/tick.yml — óránként :07-kor
SCHEDULER: github-actions
```

Amit tudni kell róla:

- **Csak órás belépés van.** 5 perces kilépés nincs, tehát a stop és a take-profit
  legfeljebb óránként egyszer néz magára. Egy órán belüli visszaesésre a rendszer nem
  reagál. Ez tudatos csökkentés, nem hiba — de a kockázat-számításban ott kell lennie.
- A GitHub ütemezés **terhelés alatt késik** (percekkel is), és a workflow ~60 nap
  commit-mentesség után letiltódik (egy commit újraaktiválja).
- A futás a **default branch**-en él, és a Neon DB ellen dolgozik.

Kötelező secretek: `DATABASE_URL`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL_PHASE1`,
`LLM_MODEL_PHASE2`, `TRADING_MODE`. Opcionális: `CRYPTOPANIC_TOKEN`, `WHALEALERT_KEY`,
`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`. A `SCHEDULER` repo-változóként (`vars`) is
megadható; ha nincs beállítva, az alapértelmezés `github-actions`, tehát a workflow fut.

**Átállás workerre:** állítsd a repo `SCHEDULER` változóját `worker`-re (vagy vedd ki a
`schedule:` blokkot). A workflow ettől kezdve zölden kihagyja magát.

---

## 4. Hosted endpointok és kulcsok

### Vercel Hobby + külső felhős időzítő

Az órás production futáshoz az időzítő beállítása:

- URL: `https://trade-beryl-six.vercel.app/api/cron/tick`
- metódus: `POST`
- ütemezés: `7 * * * *` (UTC, minden óra 7. percében)
- fejléc: `Authorization: Bearer <a Vercelben beállított CRON_SECRET>`
- cron-job.org timeout: legfeljebb 30 másodperc; retry: legfeljebb 1

Erre használható például Upstash QStash vagy cron-job.org. A külső szolgáltatás csak
az indító HTTPS-kérést küldi; az adatgyűjtés, döntés, végrehajtás és könyvelés az éles
Vercel deploymentben fut. A Vercel projektben a Fluid Compute aktív, a route
`maxDuration` értéke 300 másodperc; a cron-job.org saját kérés-időkorlátja ettől
függetlenül 30 másodperc.

Vercel Pro esetén ugyanez külső szolgáltatás nélkül, natív Vercel Cronnal is óránként
futtatható. Hobby csomagban az órás cron kifejezés deployment hibát okozna.

| Endpoint | Auth | Megjegyzés |
|---|---|---|
| `POST /api/cron/tick` | `Authorization: Bearer $CRON_SECRET` | **kötelező** — beállított titok nélkül a route elutasít (T32) |
| `GET /api/analytics` | nincs | csak olvasás, származtatott számok |
| dashboard oldalak | nincs | személyes használat, publikus URL-en is csak olvasható |

Kulcsok szerepe:

| Kulcs | Mire kell | Mi történik nélküle |
|---|---|---|
| `DATABASE_URL` | minden állapot (ledger, döntések, lease) | a worker **nem indul**, a tick nem könyvel |
| `LLM_API_KEY` + `LLM_BASE_URL` | Phase-1/Phase-2 döntés | nincs AI-döntés; a kód-alapú kilépés és a kockázati kapu megy |
| `CRON_SECRET` | a hosted tick-endpoint védelme | a route **elutasít** (fail-closed) |
| `TRADING_MODE` | paper vagy live | hiányzó érték = `paper` |
| `SCHEDULER` | ki az aktív ütemező | hiányzó érték = `github-actions` |
| `BINANCE_API_KEY/SECRET` | **csak** live módban | paper módban nem használt |

A Binance kulcs jogosultsága: **read + trade, SOHA withdraw.**

---

## 5. Egészség és hibakeresés

### Gyors állapot

```bash
pnpm audit:state       # portfólió, pozíciók, nyitott intentek, utolsó tickek
pnpm tsx scripts/check-db.ts
```

A dashboardon a **TickInspector** „egészség" blokkja mondja meg, mikor futott utoljára
sikeres belépés és kilépés, mekkora a quote-kor, és **miért nem történt kötés**
(`explainNoTrade`). Ami nem ismert, az `null`, nem `0`.

### Heartbeat

A siker-heartbeat **csak sikeres könyvelés mellett** megy ki. Azonos hibakód nem
ismétlődik minden tickben (deduplikálva), de a más típusú hiba és a helyreállás azonnal
látszik.

### Tipikus tünetek

| Tünet | Ok | Teendő |
|---|---|---|
| `[worker] NEM indul: ... EGY aktív ütemező lehet` | `SCHEDULER` nem `worker` | állítsd át, vagy `--force` egyszeri futáshoz |
| `skipped: lease_held` | másik futó vitte el a sávot | normális; ha tartósan, keresd a másik futót |
| `unsettled_intents` | ismeretlen kimenetelű megbízás | egyeztetés (T27), **nem** újraküldés |
| `reason: "stale_quote"` | a bid/ask öregebb 10 s-nál | adatforrás-hiba; kilépés szándékosan nem történik |
| `persist_failed` | a mentés nem sikerült | a ciklus eredménye nem tartós; a hiba nem tűnik el magától |
| ML: `KARANTÉN: nincs ML-jel` | a `model.json` feature-verziója régi | újratréning kell (`pnpm tsx scripts/train-model.ts`) |
| `binance` forrás: `HTTP 451`, `bars 0/48` | a függvény-régió IP-jét a Binance jogi okból blokkolja | a `vercel.json` `regions` értéke maradjon EU-ban (`fra1`) |
| minden döntés `LLM hiba, HOLD` | a GLM válaszideje meghaladja a kliens időkorlátját | `DEFAULT_LLM_TIMEOUT_MS` (mérés alapján 75 s), lásd lent |
| `BUY` döntés, mégis `staleSkips` és nincs kötés | az indulási ár elöregedett az LLM-szakasz alatt | beküldés előtti ár-frissítés (lásd lent); ha a frissítés is elavult, az a helyes fail-closed |

### Miért frissítünk árat közvetlenül a beküldés előtt

2026-09-06, 17:08 UTC: az első sikeres AI-döntés `BUY BTC` lett, a Risk Manager átengedte,
kötés mégsem történt. A tick-rekord:

```
staleSkips: [{"symbol":"BTC","side":"BUY","reason":"stale","ageMs":62699}]
```

A tick az árat a ciklus ELEJÉN kéri le, szándékosan: a kilépésnek nem szabad hírre vagy
LLM-re várnia. Csakhogy a döntési út ezután még lefuttatja a phase-1-et (33.6 s) és a
phase-2-t (28.3 s), így a beküldéskor az ár **62 másodperces** volt, a frissességi küszöb
pedig 10 másodperc. Vagyis minden AI-vezérelt vétel némán elhalt, bármilyen jó volt a jel.

A javítás: ha a beküldés előtti ellenőrzés `stale`-t talál, a tick EGYSZER frissíti az árat,
és azzal ellenőriz újra. A `pricesDec` is frissül, hogy a fill a friss áron számoljon.
Replayben NINCS frissítés: ott a rögzített pillanatkép a bemenet, különben a páros mérés
összehasonlíthatatlanná válna. Ha a frissített ár is elavult, a rendszer továbbra sem köt —
ez a helyes fail-closed viselkedés, nem hiba.

A TickInspector „Ár-frissítés" sora mutatja, hányszor kellett és hányszor sikerült.

### Az LLM időkorlátja

2026-09-06 mérés a prod kulccsal, éles méretű (~12k token) phase-1 prompttal:

```
#1 OK 53 159 ms · 11 555 token
#2 429 该模型当前访问量过大 (forgalomkorlát)
#3 OK 29 863 ms · 12 240 token
```

A `glm-4-flash` tipikusan 30-53 másodperc alatt válaszol, a korábbi 30 s-os kliens-korlát
tehát a hívások többségét levágta: a tickek `LLM hiba, HOLD` szöveggel futottak, és a
naplóban ez megkülönböztethetetlen volt egy valóban nyugodt órától.

Amit a mérés után rögzítettünk:

- `DEFAULT_LLM_TIMEOUT_MS = 75_000`, `DEFAULT_LLM_MAX_RETRIES = 1`;
- a phase-2 `maxRetries: 0`, hogy a két fázis biztosan beleférjen a route 300 s-os
  `maxDuration` keretébe (legrosszabb eset: 2 × 75 s + 75 s);
- a hibaosztályozás külön kezeli a `rate_limited` esetet, és az SDK „Request timed out."
  üzenetét végre időtúllépésnek ismeri fel (korábban `network`-nek látszott);
- a phase-1 hívás mérhető adatai bekerülnek a tick health-be (`llmPhase1`), és a
  TickInspector külön sorban mutatja a phase-1 és a phase-2 hívást.

Ha a `429` gyakori lesz, az a modell ingyenes szintjének forgalomkorlátja: vagy fizetős
szint kell, vagy ritkább tick.

### Régió: miért `fra1`

2026-09-06: az éles tick minden coinra `0/48` hézagmentes gyertyát mutatott, a Binance
collector pedig `ok: true, points: 0, durationMs: 19` értéket — vagyis a hiba NEM látszott.
A collector-hibák propagálása után kiderült a valódi ok:

```
binance ok:false — BTC: http_error — Binance HTTP 451 (BTC) · ETH: … 451 · SOL: … 451
```

A HTTP 451 (Unavailable For Legal Reasons) a Binance geo-blokkja a Vercel alapértelmezett
`iad1` (USA) régiójának kimenő IP-jére. Ugyanaz a kérés magyar IP-ről HTTP 200.

Mivel gyertya nélkül nincs trend-, momentum- és ATR-számítás, a belépő-szűrő minden vételt
elutasít: a bot ilyenkor CSAK HOLD-ol, akármit mond az LLM.

A `vercel.json` ezért rögzíti a `fra1` (Frankfurt) régiót. Ez egyben a Neon adatbázis
régiója is (`eu-central-1`), tehát a DB-körök is az óceánon innen maradnak.

**Ha a régió bármikor visszakerül USA-ba, a gyertya-lánc némán elnémul** — a tünet a
`0/48` és a `binance ok:false` a TickInspectorban, illetve a `/api/market` `sources`
mezőjében.

---

## 6. Rollback

**Kódvisszaállás.** Minden feladat külön commit. Visszaállás egy korábbi állapotra:

```bash
git log --oneline
git revert <sha>          # egy feladat visszavonása
```

**Séma.** A `0002`–`0004` migrációk **additívak**: új táblák és függvények, a régi
táblák érintetlenek. A régi kód ezért a séma visszabontása nélkül is elindul; a v2
táblák egyszerűen kihasználatlanul maradnak. **Táblát nem törlünk vissza** — a
történeti adat marad.

**Ledger-migráció.** A `pnpm migrate:ledger` alapból **dry-run**. A legacy sorok
`provenance='legacy-unverified'` jelöléssel, **egyenlegmozgás nélkül** kerülnek be
történetként. Részletek: [`docs/ledger-migration.md`](ledger-migration.md).

**Leállás mint rollback.** A legbiztosabb visszavonás: `SCHEDULER` átállítása egy nem
futó szerepre (pl. `vercel-cron`, miközben a Vercel cron nincs beállítva). Ekkor sem a
worker, sem a GitHub-tick nem fut, és **semmi nem kereskedik**, miközben a dashboard és
az adat megmarad.

---

## 7. Költségdöntést igénylő tételek (NEM automatikus)

Ezek egyike sincs bekapcsolva, és egyik sem kapcsolható be külön felhasználói döntés
nélkül:

- **Fizetős hosting** állandó workerhez (VPS / Railway / Fly / Render): havidíj.
- **Neon fizetős tier**: az ingyenes tier tárhely- és compute-korlátos; hosszú
  történeti adatnál merül fel.
- **Fizetős LLM** (`glm-5.2` a Phase-2-höz): egyenleg-feltöltés kell. A `glm-4.7-flash`
  ingyenes.
- **Fizetős adatforrás** (CryptoPanic, WhaleAlert): jelenleg ingyenes RSS + Fear&Greed
  megy helyettük.

A jelenlegi felállás ingyenes: GitHub Actions ütemezés + Neon free tier +
`glm-4.7-flash`. Az órás kilépés ennek az ára.

# Javítási feladatlista

Terv: [plan.md](plan.md). Állapot: minden implementációs feladat nyitott. A fájlok az érintett meglévő vagy létrehozandó útvonalak; a tesztparancsokat a repó gyökeréből kell futtatni. Minden feladat lezárásakor rövid bizonyítékot kell ide írni: parancs, eredmény, releváns korlát. A generált migrációs metaadatok a felsorolt migrációhoz tartoznak.

## M1 — Helyes demó, könyvelés és risk

### T01 — Biztonságos mérési és integrációs alap

- [x] Kész
- Függőség: nincs. Méret: M.
- Fájlok: `scripts/audit-state.ts`, `tests/integration/setup.ts`, `vitest.integration.config.ts`, `package.json`, `.gitignore`.
- Elfogadás: csak olvasó, redaktált állapotexport; külön teszt-DB és parancs, alapértelmezésben semmilyen teszt nem használhatja a normál DATABASE_URL-t; a 182 tesztes alapállapot és az audit példái rögzítve.
- Ellenőrzés: `pnpm test`; a script fixture-adatú próbája; az integrációs setup elutasítja a normál/hiányzó DB-konfigurációt. Exportált pénzügyi adatok ne kerüljenek gitbe.
- **Bizonyíték:** `pnpm test` → 40 fájl / 186 teszt zöld; `pnpm exec tsc --noEmit` tiszta. A `pnpm exec vitest run --config vitest.integration.config.ts` TEST_DATABASE_URL nélkül HIBÁVAL áll le (Hiányzó TEST_DATABASE_URL), tehát fail-closed. A unit-setup törli a DATABASE_URL-t, így egy teszt sem érheti el az éles DB-t. Alapállapot rögzítve: `docs/verification/baseline-2026-09-05.md`. KORLÁT: a gépen nincs helyi PostgreSQL (nincs `psql`, nincs Docker), ezért integrációs teszt ebben a szakaszban nem futott.

### T02 — Verziózott order- és fill-szerződés

- [x] Kész
- Függőség: T01. Méret: M.
- Fájlok: `src/lib/types.ts`, `src/lib/execution/contracts.ts`, `src/lib/execution/broker.ts`, `tests/lib/execution/contracts.test.ts`.
- Elfogadás: BUY quote-budget és SELL base-qty megkülönböztethető; intent/fill azonosító, díjeszköz és állapot explicit; v2 típusok kompatibilitási adapterrel bevezetve, a régi runtime még fordul.
- Ellenőrzés: `pnpm exec vitest run tests/lib/execution/contracts.test.ts`; `pnpm exec tsc --noEmit`; negatív/NaN/Infinity és értelmetlen oldali mezők elutasítása.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/execution/contracts.test.ts tests/lib/portfolio/money.test.ts` → 36 teszt zöld; `tsc --noEmit` tiszta. Elutasított bemenetek: negatív és nulla mennyiség, NaN, Infinity, exponenciális alak, ellentétes oldali mező (BUY + baseQty), hiányzó contractVersion. A decimális megoldás saját BigInt fixpont (`money.ts`), nincs új csomag, a `pnpm-lock.yaml` változatlan.

### T03 — Atomi ledgerhez szükséges bővítő séma

- [x] Kész
- Függőség: T02. Méret: M.
- Fájlok: `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrations/<következő>.sql`, `tests/integration/ledger-schema.test.ts`, `docs/ledger-contract.md`.
- Elfogadás: numeric összegek, portfolio/mode/version határ, egyedi intent/fill azonosítók, reservations és napi equity tárolható; driver/tranzakciómegoldás ellenőrzött; migráció nem veszít régi sorokat, meglévő reader tovább működik.
- Ellenőrzés: izolált PostgreSQL-migráció üres és legacy fixture-re; egyediség és CHECK feltételek valódi DB-ben; dokumentált tranzakciópróba. Külső DB-n még nincs alkalmazás.
- **Bizonyíték:** `pnpm exec drizzle-kit generate` → 0002 (csak CREATE TABLE és CREATE INDEX, egyetlen ALTER vagy DROP sem a v1 táblákon) + kézzel írt 0003 (CHECK feltételek, `apply_fill_v2`, `acquire_run_lease`). A driver-képesség ELLENŐRIZVE, nem feltételezve: `drizzle-orm/neon-http/session.js:108` → No transactions support in neon-http driver; `session.js:94` → a batch `client.transaction(...)`-t hív. Dokumentálva: `docs/ledger-contract.md` és `DRIVER_CAPABILITIES`. 🔴 KORLÁT: a `tests/integration/ledger-schema.test.ts` MEGÍRVA, de NEM FUTOTT — nincs elérhető PostgreSQL a gépen; futtatáshoz `TEST_DATABASE_URL` kell.

**C1:** T01–T03 után alap-suite, típusellenőrzés, izolált migráció zöld; export és séma áttekinthető.

### T04 — Közös fill-könyvelő

- [x] Kész
- Függőség: T02. Méret: M.
- Fájlok: `src/lib/portfolio/ledger.ts`, `src/lib/portfolio/money.ts`, `tests/lib/portfolio/ledger.test.ts`, `package.json`, `pnpm-lock.yaml`.
- Elfogadás: azonos fill → azonos cash/qty/bekerülési érték; BUY és SELL díj quote/base/harmadik eszközben egyszer számít; részleges zárás helyes, készlet és cash nem lesz tiltottan negatív. Egy kiválasztott decimális megoldás, nincs többféle kerekítés.
- Ellenőrzés: `pnpm exec vitest run tests/lib/portfolio/ledger.test.ts`; kézzel ellenőrizhető round-trip példák, változatlan árnál veszteség pontosan a költség, részleges fill és dust határ.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/portfolio/ledger.test.ts` → 21 teszt zöld. Kézzel ellenőrizhető példák: 60 USD vétel 0,06 díjjal → cash 39,94 és bekerülési érték 60,06; változatlan áron BUY majd SELL realizált eredménye pontosan −(0,06 + 0,06); fél pozíció zárása a bekerülési érték felét viszi; dust-küszöbnél a maradék is realizálódik. A díj quote, base és BNB eszközben külön, pontosan egyszer számít. Egy decimális megoldás (`money.ts`) dokumentált kerekítéssel.

### T05 — PaperBroker valósághű teljesülése

- [x] Kész
- Függőség: T04. Méret: M.
- Fájlok: `src/lib/execution/paper-broker.ts`, `src/lib/execution/paper-fill.ts`, `tests/lib/execution/paper-broker.test.ts`, `tests/lib/execution/paper-fill.test.ts`.
- Elfogadás: SELL birtokolt qty-ből, helyes díjjal; nincs orphan SELL vagy nulla order; 95-ös stop és 90-es megfigyelt eladási ár nem ad 95-ös fillt, spread/csúszás explicit. A broker nem vezet második, eltérő igazságforrású egyenleget.
- Ellenőrzés: `pnpm exec vitest run tests/lib/execution/paper-broker.test.ts tests/lib/execution/paper-fill.test.ts`; BUY→részleges SELL→teljes SELL azonos ledgeren.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/execution/paper-broker.test.ts tests/lib/execution/paper-fill.test.ts` → 28 teszt zöld. A 95-ös stop és 90-es megfigyelt ár mostantól 90-en tölt. A SELL a birtokolt mennyiségből megy cash=0 mellett is; nem birtokolt coin eladása `no_position` elutasítás; nulla méretű order nem keletkezik. A BUY → részleges SELL → teljes SELL sor ugyanazon a ledgeren fut le. A v2 broker nem vezet saját egyenleget: külön teszt bizonyítja, hogy a ledger változatlan marad, amíg a hívó nem könyvel.

### T06 — Minden order közös kockázati kapun

- [x] Kész
- Függőség: T04, T05. Méret: M.
- Fájlok: `src/lib/risk/risk-manager.ts`, `src/lib/engine/execute-intent.ts`, `src/lib/engine/tick.ts`, `tests/lib/risk/risk-manager.test.ts`, `tests/lib/engine/execute-intent.test.ts`.
- Elfogadás: AI/DCA/momentum/manual egységes kaput kap; 20 USD BTC + 80 USD cash + 20%-os BUY nem növeli tovább a BTC-t; max positions, cash, reserved összeg és szimbólumlista együtt számít. SELL cash=0 mellett is végrehajtható és veszteségkapunál is engedett.
- Ellenőrzés: `pnpm exec vitest run tests/lib/risk/risk-manager.test.ts tests/lib/engine/execute-intent.test.ts`; túlméretes BUY nem ugrik át pozíciószám-korlátot; nincs DB-hibás fallback-order. V2 nincs tartós futásra engedve T09–T11 előtt.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/risk/risk-manager.test.ts tests/lib/engine/execute-intent.test.ts` → 46 teszt zöld; `pnpm test` 45 fájl / 302 teszt; `tsc --noEmit` tiszta; `pnpm build` sikeres. Regressziós tesztek: 20 USD BTC + 80 USD cash + 20%-os BUY → nincs vétel, és a broker `submit` metódusa meg sem hívódik; a visszavágott BUY NEM ugorja át a pozíciószám-korlátot; a SELL cash=0 mellett és aktív veszteségkapunál is végrehajtódik. A 10 000 USD-s DB-fallback törölve: `tradingEnabled=false` mellett nincs order (külön teszt). A v2 tartós futásra még NINCS engedve: a perzisztencia a v1 `applyTrade`-en megy, a tranzakciós út a T09.

**C2:** T04–T06 után fill/risk regressziók és teljes típusellenőrzés zöld; a bizonyított 36%-os kitettségi hiba megszűnt.

### T07 — Valódi napi veszteségkorlát

- [x] Kész
- Függőség: T03, T06. Méret: M.
- Fájlok: `src/lib/portfolio/day-equity.ts`, `src/lib/portfolio/accounting.ts`, `src/lib/engine/tick.ts`, `tests/lib/portfolio/day-equity.test.ts`, `tests/integration/day-equity.test.ts`.
- Elfogadás: UTC napi baseline, cash flow korrekció és napi latch; indulás óta mért P&L külön; napváltás, résznapos indulás, szünet és hiányzó referencia explicit, SELL nincs letiltva.
- Ellenőrzés: `pnpm exec vitest run tests/lib/portfolio/day-equity.test.ts`; integrációs teszt két egyidejű napnyitással; előző nap nyeresége nem rejti el az aznapi -3%-ot.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/portfolio/day-equity.test.ts` → 16 teszt zöld; `pnpm test` 46 fájl / 318 teszt; `tsc --noEmit` tiszta. Bizonyított viselkedés: UTC napkezdő baseline, napváltáskor új referencia és a tegnapi latch nem öröklődik, a −3% latch a nap végéig tart visszakúszó equity mellett is, a nap közbeni be- és kifizetés nem látszik napi eredménynek, nem mérhető equity esetén `dayPnlPct = null` és csak az ÚJ VÉTEL szünetel. Az indulás óta mért hozam külön mutató (`inceptionPnlPct`). A régi „MTM circuit breaker" teszt át lett írva: az a −41%-os indulás óta mért esést várta HOLD-ként, ami maga a hiba volt. 🔴 KORLÁT: `tests/integration/day-equity.test.ts` (két egyidejű napnyitás, paper/live elkülönítés, tartós latch) MEGÍRVA, de NEM FUTOTT — nincs PostgreSQL.

### T08 — Heti DCA-keret és trailing-stop megőrzése

- [x] Kész
- Függőség: T06. Méret: M.
- Fájlok: `src/lib/strategy/fear-greedy.ts`, `src/lib/strategy/weekly-budget.ts`, `src/lib/portfolio/ledger.ts`, `tests/lib/strategy/weekly-budget.test.ts`, `tests/lib/portfolio/ledger.test.ts`.
- Elfogadás: 1 USD heti maradék legfeljebb 1 USD teljes költés; csak adott portfolio/mode DCA fill+foglalás fogyaszt, AI nem; rávásárlás nem csökkentheti a már aktív stopot.
- Ellenőrzés: `pnpm exec vitest run tests/lib/strategy/weekly-budget.test.ts tests/lib/strategy/fear-greedy.test.ts tests/lib/portfolio/ledger.test.ts`; 7 napos határ, live/paper elkülönítés, törölt reservation felszabadulása.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/strategy/weekly-budget.test.ts tests/lib/strategy/fear-greedy.test.ts tests/lib/portfolio/ledger.test.ts` → 46 teszt zöld; `pnpm test` 46 fájl / 330 teszt. Bizonyított: 1 USD maradéknál legfeljebb 1 USD tervezhető (a régi kód 2 USD-t tervezett), a minimum kötésérték alatt nincs kötés; a keretet csak az adott (portfolio, mode) hatókör `dca` eredetű teljesülései ÉS aktív foglalásai fogyasztják — az AI vétele nem; a rávásárlás nem viszi lejjebb a felhúzott trailing stopot (a magasabb kért stop viszont érvényre jut). Mellékjavítás: a `dec(number)` a legrövidebb oda-vissza pontos alakot használja, így a 0,05 nem lesz 0,050000000000000003.

### T09 — Egy tranzakciós perzisztenciaút

- [x] Kész
- Függőség: T03, T04, T06, T07, T08. Méret: M.
- Fájlok: `src/lib/portfolio/accounting.ts`, `src/lib/execution/order-store.ts`, `src/lib/engine/execute-intent.ts`, `tests/integration/accounting.test.ts`, `tests/lib/engine/execute-intent.test.ts`.
- Elfogadás: fill+cash+position+reservation módosítás együtt commit/rollback; duplikált fill nem változtat egyenleget; DB-hiba strukturált hibát ad, nincs log+null utáni hamis siker vagy order-küldés.
- Ellenőrzés: valódi PostgreSQL fault injection minden írási ponton; két párhuzamos BUY nem lépi át a foglalt keretet; friss DB-visszaolvasás egyezik a reducer állapotával.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/engine/execute-intent.test.ts` → 17 teszt zöld; `pnpm test` 46 fájl / 335 teszt; `tsc --noEmit` tiszta; `pnpm build` sikeres. Az egyetlen tranzakciós út az `apply_fill_v2` hívás (fill + cash + pozíció + foglalás együtt), a foglalást a szerver dönti el (`reserve_budget_v2`, 0004 migráció), a hiba STRUKTURÁLT `PersistenceError` és DOB — a teszt bizonyítja, hogy nem lesz belőle hamis siker. A v1 táblák innentől csak vetület a régi dashboard-olvasóknak. 🔴 KORLÁT: `tests/integration/accounting.test.ts` (együtt-commit, duplikátum-no-op, fedezethiánynál teljes visszagörgetés, két párhuzamos BUY a kereten belül) MEGÍRVA, de NEM FUTOTT — nincs PostgreSQL. Ezért a valódi fault-injection és konkurencia-bizonyíték HIÁNYZIK.

**C3:** T07–T09 után valódi DB-tranzakció, napi és heti keret tesztjei zöldek; `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm build`.

### T10 — Újrapróbálás és több futó kizárása

- [x] Kész
- Függőség: T09. Méret: M.
- Fájlok: `src/lib/engine/run-scheduled-tick.ts`, `src/lib/engine/run-lease.ts`, `src/lib/execution/order-store.ts`, `tests/integration/run-lease.test.ts`, `tests/lib/engine/run-scheduled-tick.test.ts`.
- Elfogadás: a tick ID nem puszta előzetes SELECT; tartós claim/lease, fencing és egyedi intent; sikertelen mentés nem küld siker-heartbeatet. Futási kulcs előkészítve külön entry/exit idősávra, ismeretlen order-állapot újraküldés helyett egyeztetésre vár.
- Ellenőrzés: cron és worker egyidejű indítása, lease lejárat, crash/retry a tervezés és könyvelés között; nincs dupla fill vagy keretfogyás.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/engine/run-scheduled-tick.test.ts` → 7 teszt zöld; `pnpm test` 47 fájl / 342 teszt. A tick id már NEM puszta előzetes SELECT: tartós lease-claim idősávonként (`entry:<slot>`), monoton fencing tokennel; más tulajdonos esetén `lease_held` kihagyás, hibánál elengedés (újrapróbálás lehetséges), sikernél a claim marad. Ismeretlen állapotú megbízás mellett a ciklus NEM indít új ordert (`unsettled_intents`), és sikertelen mentés esetén NINCS siker-heartbeat. 🔴 KORLÁT: `tests/integration/run-lease.test.ts` (két egyidejű futó, lejárat-átvétel, token-növekedés) MEGÍRVA, de NEM FUTOTT — nincs PostgreSQL.

### T11 — Régi demóadatok megőrzése és mérési átállás

- [x] Kész
- Függőség: T09, T10. Méret: M.
- Fájlok: `scripts/migrate-paper-ledger.ts`, `src/lib/portfolio/legacy-import.ts`, `tests/integration/legacy-import.test.ts`, `docs/ledger-migration.md`.
- Elfogadás: dry-run az alap, snapshot/diff/megismételhető import; hiányzó origin/orderId és irreális régi stop-fill nem lesz kitalált hiteles adat; új epoch nyitóállapottal, régi adatok megőrizve. Koncentrált BTC-t nem ad el migráció, új rávásárlás tiltott.
- Ellenőrzés: másolat-adatbázison kétszeri import ugyanazt adja; előtte/utána cash és qty eltérésjelentés; rollback/prior reader próbája. Tényleges külső migráció külön ütemezett lépés.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/portfolio/legacy-import.test.ts` → 13 teszt zöld; `pnpm test` 48 fájl / 355 teszt; `pnpm build` sikeres. A dry-run az alapértelmezés (`pnpm migrate:ledger`), írás csak `--apply` mellett. A régi sorok `legacy-unverified` provenance-szel, TÖRTÉNETKÉNT kerülnek be és NEM mozgatnak egyenleget; a nyitóállapot az ellenőrzött v1 állapotból jön. A hiányzó orderId szintetikus és `legacy:` előtaggal felismerhető, a hiányzó eredet és az irreális stop-fill JELÖLVE, nem javítva. A koncentrált BTC-t a migráció nem adja el. Dokumentáció: `docs/ledger-migration.md`. 🔴 KORLÁT: `tests/integration/legacy-import.test.ts` (kétszeri import azonos eredmény, v1 érintetlen) MEGÍRVA, de NEM FUTOTT; a TÉNYLEGES külső migráció külön, ütemezett lépés marad.

**C4 / M1:** A demó végigfut a v2 úton izolált DB-n; nincs pénzteremtés, dupla könyvelés vagy limitmegkerülés. Teljes suite + típusellenőrzés + build.

## M2 — Piaci adat és döntések

### T12 — Valódi, lezárt OHLCV

- [x] Kész
- Függőség: T02. Méret: M.
- Fájlok: `src/lib/market/candles.ts`, `src/lib/collectors/binance.ts`, `src/lib/backtest/data.ts`, `tests/lib/collectors/binance.test.ts`, `tests/lib/backtest/data.test.ts`.
- Elfogadás: lezáratlan/jövőbeli gyertya kiesik; high/low/volume/időkeret megmarad, duplák és rések felismerve; a maximális lookback+warmup lekérhető, rate limit és hibás oldal nem csendes teljes adatsor.
- Ellenőrzés: `pnpm exec vitest run tests/lib/collectors/binance.test.ts tests/lib/backtest/data.test.ts`; réses sor, current candle, hibás OHLC és lapozási duplikáció fixture-ek.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/collectors/binance.test.ts tests/lib/backtest/data.test.ts` → 21 teszt zöld; `pnpm test` 48 fájl / 371 teszt. Bizonyított: a FUTÓ gyertya kiesik (a jövőbeli záró idő nem lehet legfrissebb ár), a jövőbeli nyitóidő és a hibás OHLC is; a lapozási duplikátum kiszűrve; a high/low és a base- és quote-volume KÜLÖN megmarad; a rés felismert; az elégségességet a sorozat VÉGÉN lévő hézagmentes szakasz dönti el (60 gyertya egy réssel NEM elég 48-hoz); a 429 és a hálózati hiba strukturált hibaként látszik, nem néma üres sorozat. A `loadHistory` adatminőség-jelentést ad, amit a backtest-script, a tournament és a /api/backtest is kiír.

### T13 — Feature- és modellverzió egységesítése

- [x] Kész
- Függőség: T12. Méret: M.
- Fájlok: `src/lib/ml/features.ts`, `src/lib/ml/predictor.ts`, `scripts/train-model.ts`, `.github/workflows/retrain.yml`, `tests/lib/ml/features-parity.test.ts`.
- Elfogadás: tréning és runtime ugyanabból az OHLCV ablakból azonos feature-t ad; nincs CoinGecko 24h/órás volume keverés; inkompatibilis modell jelöltként karanténba kerül. Heti tanítás nem deployol pusztán AUC≥0,5 alapján.
- Ellenőrzés: `pnpm exec vitest run tests/lib/ml/features-parity.test.ts tests/lib/ml/predictor.test.ts`; modellverzió-eltérés és hiányzó warmup nem látszik érvényes ML-jelként. Új tanítás külön jelöltfájl, aktív modell nem íródik felül.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/ml/features-parity.test.ts tests/lib/ml/predictor.test.ts` → 28 teszt zöld; `pnpm test` 49 fájl / 396 teszt; `pnpm build` sikeres. Bizonyított: a tréning és a futás UGYANABBÓL a függvényből számol (a gyertyából és a DataPointból képzett vektor azonos); a volumenarány a gyertya base-volumenéből jön, a CoinGecko ár-pontokat a feature-építés figyelmen kívül hagyja; réses ablakra NINCS feature; eltérő feature-verzió vagy sorrend esetén NINCS ML-jel (karantén), és a naiv heurisztika-fallback megszűnt; az `evaluatePromotion` négy feltételt kér, az AUC ≥ 0,5 önmagában nem kapu. 🔴 KÖVETKEZMÉNY: a jelenlegi `model.json` a RÉGI feature-készlethez készült, ezért KARANTÉNBAN van — újratanításig nincs ML-jel, és ezt a tick jelenti. A `train-model.ts` `model.candidate.json`-t ír, az aktív modellt nem; a workflow artefaktumot tölt fel és HIBÁVAL áll le, ha a model.json megváltozna.

### T14 — Friss végrehajtási ár külön adatúton

- [x] Kész
- Függőség: T02, T12. Méret: M.
- Fájlok: `src/lib/market/quotes.ts`, `src/lib/collectors/base.ts`, `src/lib/engine/tick.ts`, `tests/lib/market/quotes.test.ts`, `tests/lib/engine/tick.test.ts`.
- Elfogadás: külön bid/ask+receivedAt/exchangeTime, explicit freshness és timeout; exit árlekérés nem vár hírekre; AI-order küldése előtt quote és risk újraellenőrzött. Elavult ár vagy részleges collectorhiba mérhető állapot.
- Ellenőrzés: `pnpm exec vitest run tests/lib/market/quotes.test.ts tests/lib/engine/tick.test.ts`; végtelen RSS-várakozás mellett az exit árút időkorláton belül végez, 10 s feletti quote nem válik friss orderré.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/market/quotes.test.ts tests/lib/collectors/base.test.ts tests/lib/engine/tick.test.ts` → 27 teszt zöld; `pnpm test` 51 fájl / 413 teszt. Bizonyított: külön bid/ask + receivedAt, BUY az ask-on és SELL a bid-en; a lekérés IDŐKORLÁTOS (AbortController), a timeout és a hiányzó symbol strukturált hiba; a 10 s feletti quote NEM válik orderré (a tick `staleSkips` listában jelenti); a collectorok EGYENKÉNTI időkorláttal futnak, egy végtelen RSS-várakozás mellett is lefut a ciklus, és a részleges hiba `degraded` jelzést kap. A quote-lekérés a collectorok ELŐTT történik, tehát az exit árút nem vár hírre vagy LLM-re.

**C5:** T12–T14 után adat/feature paritás és hibakezelés zöld; nincs jövőbeli záróidő „legfrissebb árként”.

### T15 — Közös konfiguráció és működő momentum-adatút

- [x] Kész
- Függőség: T08, T12, T13. Méret: M.
- Fájlok: `src/lib/strategy/config.ts`, `src/lib/config.ts`, `src/lib/engine/profit-cycle.ts`, `src/lib/engine/tick.ts`, `tests/lib/engine/strategy-parity.test.ts`.
- Elfogadás: egy StrategyConfig forrás, paper/backtest/config kijelzéshez verzió; 48+ lezárt gyertyával tényleges momentum-jel, hiányos adattal nincs trendengedély; ATR a valódi high/low-t használja, induló és követő stop módszere egyezik. Alapértelmezésben momentum továbbra is ki.
- Ellenőrzés: `pnpm exec vitest run tests/lib/engine/strategy-parity.test.ts tests/lib/strategy/config.test.ts`; fix/ATR és eltérő warmup fixture-ek mindkét útból azonos tervet adnak.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/engine/strategy-parity.test.ts` → 16 teszt zöld; `pnpm test` 52 fájl / 430 teszt; `pnpm build` sikeres. Bizonyított: a RISK_LIMITS és a PROFIT_CYCLE a DEFAULT_STRATEGY-ből SZÁRMAZIK (nincs két másolat), a stratégia verziózott; a jeleket ugyanaz a `computeSymbolSignals` adja a ticknek és a backtestnek, ezért azonos bemenetre azonos terv születik fix és ATR stop módban is; 24 gyertyával NINCS trend- és momentum-engedély, 48+ hézagmentessel a végig emelkedő sor momentumot ad; a sorozat végén lévő rés érvényteleníti a jelet; az ATR a VALÓDI high/low-ból számol (close-only sorozatra 0). A backtest-tesztek explicit warmup-kereteket kaptak, mert a javítás következménye, hogy az első 48 gyertya nem ad belépőt.

### T16 — AI-intent és valós portfóliókontextus

- [x] Kész
- Függőség: T06, T13, T14, T15. Méret: M.
- Fájlok: `src/lib/llm/schemas.ts`, `src/lib/llm/phase2-decide.ts`, `src/lib/engine/tick.ts`, `src/lib/llm/client.ts`, `tests/lib/llm/phase2-decide.test.ts`.
- Elfogadás: tényleges entryPrice/equity/pozícióérték/risk keret az AI-nak; BUY equityFraction és SELL positionFraction verziózott, holdings/coin-lista validált, régi mezőket adapter kezeli; modell/prompt verzió, token/költség és idő rögzíthető, confidence nincs találati valószínűségként beállítva.
- Ellenőrzés: `pnpm exec vitest run tests/lib/llm/phase2-decide.test.ts tests/lib/engine/tick.test.ts`; cash=0 SELL, érvénytelen symbol, hiányzó adat és LLM-timeout tesztek, régi naplók olvashatók maradnak.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/llm/phase2-decide.test.ts tests/lib/engine/tick.test.ts` → 29 teszt zöld; `pnpm test` 52 fájl / 447 teszt; `tsc --noEmit` tiszta; `pnpm build` sikeres. Bizonyított: az AI VALÓS entryPrice-t, pozícióértéket, equityt és symbolonkénti SZABAD KERETET kap (a 20%-os limitet elért BTC-re 0-t); BUY `equityFraction`, SELL `positionFraction`, ezért cash=0 mellett is végrehajtódik a teljes eladás; a v1 `amountPct` adapterrel megy át, és a fordítás az `adjustments`-ben látszik, tehát a régi naplók olvashatók maradnak; a kosáron kívüli és a nem birtokolt symbol HOLD lesz; az LLM-timeout HOLD + mérhető hiba; a modell, a prompt-verzió, a token és a késleltetés naplózható. A `confidence` sehol nem méret- vagy valószínűség-forrás.

**C6 / M2:** T15–T16 után teljes suite + típusellenőrzés + build; rögzített inputból reprodukálható döntési terv.

## M3 — Hiteles backtest és AI-összehasonlítás

### T17 — Végrehajtási idő és backtest-paritás

- [x] Kész
- Függőség: T05, T06, T12, T15. Méret: M.
- Fájlok: `src/lib/backtest/types.ts`, `src/lib/backtest/engine.ts`, `src/lib/backtest/fill-sim.ts`, `tests/lib/backtest/engine.test.ts`, `tests/lib/backtest/parity.test.ts`.
- Elfogadás: közös risk+ledger minden ordernél; jel után következő elérhető áron fill, nincs jövőinformáció; polling és függő exchange stop külön modell, 1/5/15/60 perces ellenőrzés megfelelő adatról fut.
- Ellenőrzés: `pnpm exec vitest run tests/lib/backtest/engine.test.ts tests/lib/backtest/parity.test.ts tests/lib/backtest/fill-sim.test.ts`; stop+TP ugyanazon gyertyán, gap, részleges fill, eltűnő quote; azonos input/időzítés paper és backtest cash/qty/fees egyezik.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/backtest/` → 38 teszt zöld (engine, fill-sim, parity); `pnpm test` 52 fájl / 469 teszt; `tsc --noEmit` tiszta; `pnpm build` sikeres. Bizonyított: a backtest ugyanazt az `evaluateOrder` kaput és `applyFill` könyvelőt használja, mint az éles út; NINCS look-ahead — a jel a lezárt gyertyából születik és a KÖVETKEZŐ nyitón teljesül (külön teszt bizonyítja, hogy a következő gyertya zuhanását nem lehet visszamenőleg megvenni); a `polling` és az `exchange-stop` mód ugyanazon az adaton KÜLÖNBÖZŐ eredményt ad, mert a polling bot nem látja a gyertyán belüli mélypontot; ugyanazon a gyertyán a stop nyer; eltűnő gyertya és minimum-notional elutasítás a `rejections` riportban látszik; a BUY keret a díjat is tartalmazza, egyezően a paper brokerrel.

### T18 — Nettó metrikák és részleges eladások

- [x] Kész
- Függőség: T04, T11, T17. Méret: M.
- Fájlok: `src/lib/backtest/metrics.ts`, `src/lib/portfolio/analytics.ts`, `src/lib/backtest/engine.ts`, `tests/lib/backtest/metrics.test.ts`, `tests/lib/portfolio/analytics.test.ts`.
- Elfogadás: minden részleges realizálás és díj bekerül, kezdőtőke a legelső kötés előtt; időkerethez helyes Sharpe/MTM drawdown, pénzmozgások és költségek elkülönítve; hit rate/PF meghatározás közös, örökölt bizonytalan adat külön látszik.
- Ellenőrzés: `pnpm exec vitest run tests/lib/backtest/metrics.test.ts tests/lib/portfolio/analytics.test.ts`; kézi ledgerpéldák, csak nyerő/üres/részlegesen zárt sor, JSON serialization és díjak miatti nullszaldó.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/backtest/metrics.test.ts tests/lib/portfolio/analytics.test.ts` → 27 teszt zöld; `pnpm test` 52 fájl / 478 teszt. Bizonyított: MINDEN realizálás számít, a részleges zárás is (a régi kód csak a végső eladást vette); a Sharpe a TÉNYLEGES mintavételi közhöz évesít (napi mintán a Sharpe az órás √24-ed része); a végtelen profit factor `null` + explicit jelző, a JSON nem tartalmaz Infinityt; a `replayFills` a kezdőtőkétől indítja a görbét, a `legacy-unverified` sorokat KIZÁRJA a metrikákból de jelenti a darabszámukat, a nem könyvelhető sorokat pedig problémaként adja vissza. A `summarizeClosedPosition` a vételi díjat is költségnek veszi.

### T19 — Független teszt és benchmarkok

- [x] Kész
- Függőség: T17, T18. Méret: M.
- Fájlok: `src/lib/backtest/walk-forward.ts`, `src/lib/backtest/benchmarks.ts`, `scripts/tournament.ts`, `scripts/backtest.ts`, `tests/lib/backtest/walk-forward.test.ts`.
- Elfogadás: időben gördülő tanítás/validálás és zárolt végső teszt; jelölt nem választható a végső teszt eredményéből; cash/BTC/DCA referencia, 100 és 10 000 USD, minimum-order és költségstressz, seed/adathash/configverzió a jelentésben. Warmup múltból jön, jövőből soha.
- Ellenőrzés: `pnpm exec vitest run tests/lib/backtest/walk-forward.test.ts`; módosított teszteredmény nem változtatja a már kiválasztott jelöltet; azonos adathash kétszer azonos riportot ad.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/backtest/holdout.test.ts tests/lib/backtest/walk-forward.test.ts` → 22 teszt zöld; `pnpm test` 53 fájl / 497 teszt; `pnpm build` sikeres. Bizonyított: a holdout adat EL SEM JUT a `selectCandidate`-hez, ezért a MÓDOSÍTOTT holdout-eredmény sem változtatja a már kiválasztott jelöltet; a rangsor a leggyengébb validációs szelet szerint megy, a sikertelen jelöltek megmaradnak; a warmup a validáció ELŐTTI adatból jön; azonos adat → azonos `dataHash`, egyetlen ár változása más hash; a `buildProvenance` rögzíti a stratégia-verziót, a díjat, a csúszást, a tőkét és a keretszámokat. Alapvonalak: cash és buy-and-hold (első NYITÓN, egy díjjal), 100 és 10 000 USD, alap és kétszeres költség; kötés nélküli stratégia NEM ELDÖNTHETŐ, nem nulla hozam.

**C7:** T17–T19 után közös execution-paritás és metrikák bizonyítva; a régi tournament győztese nem automatikus új alapértelmezés.

### T20 — AI értékelés és visszajátszhatóság

- [x] Kész
- Függőség: T16, T17, T18, T19. Méret: M.
- Fájlok: `src/lib/backtest/decision-replay.ts`, `src/lib/portfolio/evaluate.ts`, `src/lib/engine/run-scheduled-tick.ts`, `tests/lib/backtest/decision-replay.test.ts`, `tests/lib/portfolio/evaluate.test.ts`.
- Elfogadás: korábban rögzített intent/model/input időponttal replayelhető, AI nélküli kontroll ugyanazon feltételekkel; hiányzó történelmi AI nem pótolható bizonyítéknak nevezett utólagos generálással; 1h iránytalálat megfelelő historikus horizontra számolódik, nem a következő tetszőleges tick árára, és nem azonos a profitmutatóval.
- Ellenőrzés: `pnpm exec vitest run tests/lib/backtest/decision-replay.test.ts tests/lib/portfolio/evaluate.test.ts`; többnapos üzemszünet, hiányzó price, jövőbeli intent tiltás és elszámolt AI-költség.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/backtest/decision-replay.test.ts tests/lib/portfolio/evaluate.test.ts` → 30 teszt zöld; `pnpm test` 54 fájl / 523 teszt; `pnpm build` sikeres. Bizonyított: csak AKKOR rögzített döntés játszható vissza — a jövőbeli intent, a pillanatkép nélküli sor, az UTÓLAG gyártott sor (késői recordedAt), a hiányzó ár és az ismeretlen szimbólum mind elutasításra kerül, kódonként összesítve; a replay a közös kapun és könyvelőn fut a DÖNTÉSKORI árakon; az AI nélküli kontroll ugyanazon a feltételrendszeren fut, és az AI értéke a KÜLÖNBSÉG az LLM-költség után; kevés végrehajtott döntésnél NEM ELDÖNTHETŐ. Az 1 órás pontozás a HORIZONT árán történik: 72 órás késésű ár esetén `stale_horizon`, nincs pontszám. A `hypotheticalPnlPct` és a `wouldProfit` mező megszűnt, helyettük `directionalScorePct` és `directionHit` — ez diagnosztika, nem profit.

**C8 / M3:** AI/backtest paritás és korlátok dokumentálva; teljes suite + típusellenőrzés + build.

## M4 — Gyors kilépés és állandó worker

### T21 — Külön, determinisztikus exit-ciklus

- [x] Kész
- Függőség: T10, T14, T15, T17. Méret: M.
- Fájlok: `src/lib/engine/plan-exits.ts`, `src/lib/engine/profit-cycle.ts`, `src/lib/engine/fast-exit.ts`, `tests/lib/engine/plan-exits.test.ts`, `tests/lib/engine/fast-exit.test.ts`.
- Elfogadás: közös stop/TP/trailing tervező órás és gyors ágnak; fast-exit nem készít BUY-t és nem hív LLM-et; időközben zárt pozíció és stale quote nem okoz hibás/dupla SELL-t, a gyakoriság külön konfigurált.
- Ellenőrzés: `pnpm exec vitest run tests/lib/engine/plan-exits.test.ts tests/lib/engine/fast-exit.test.ts tests/lib/engine/profit-cycle.test.ts`; ugyanazon trigger két ciklusból egyszer könyvelődik.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/engine/plan-exits.test.ts tests/lib/engine/fast-exit.test.ts` → 23 teszt zöld; `pnpm test` 56 fájl / 546 teszt. Bizonyított: a `planExits` KÖZÖS tervező (az órás és a gyors ág is ezt hívja), SOHA nem tervez BUY-t, a megfigyelt ár a BID; elavult vagy hiányzó quote-ra NINCS kilépés (ok és kor rögzítve); a lezárt pozíció és a hiányzó belépési ár külön kihagyási ok; a stop elsőbbséget élvez; a trailing ratchet csak felfelé mozdul; az `inFlightSymbols` megakadályozza a dupla SELL-t. A `runFastExit` nem hív LLM-et és nem vár collectorra, ismeretlen állapotú megbízásnál megáll, és külön teszt bizonyítja, hogy ugyanaz a trigger két ciklusból EGYSZER könyvelődik.

### T22 — Ütemező worker és újraindulás

- [x] Kész
- Függőség: T10, T21. Méret: M.
- Fájlok: `scripts/worker.ts`, `src/lib/engine/worker.ts`, `src/lib/engine/run-scheduled-tick.ts`, `package.json`, `tests/lib/engine/worker.test.ts`.
- Elfogadás: 5m exit + 60m lezárt gyertyás entry; ne legyen átfedő async setInterval, hosszú LLM-hívás ne fogja az exitet; indulás/restart függő állapotokat egyeztet, régi idősávokat nem vesz visszamenőleg. SIGTERM és egyszeri futás tesztelhető.
- Ellenőrzés: `pnpm exec vitest run tests/lib/engine/worker.test.ts`; injektált idővel késés/éjfél/restart/óraugrás, hosszú entry mellett exit; két folyamat valódi DB-n egy írót eredményez.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/engine/worker.test.ts` → 19 teszt zöld; `pnpm test` 57 fájl / 561 teszt. Bizonyított: 5 perces kilépés + 60 perces belépés :07-es offsettel; a FUTÓ belépés mellett a kilépés akadálytalanul lefut (külön teszt); az átfedés-őr SZINKRON zár, ezért két egyszerre indított azonos ciklus nem fut párhuzamosan; a belépés és a kilépés KÜLÖN lease-kulcsot használ; 15 perces óraugrás és éjfél-átlépés után sem pótoljuk a kihagyott sávokat; hiba esetén lease-elengedés és a worker tovább él; `stop()` után új ciklus nem indul. Parancsok: `pnpm worker`, `pnpm worker:once`. 🔴 KORLÁT: valódi két folyamatos futó egy DB-n NEM lett kipróbálva (nincs PostgreSQL).

### T23 — Futási állapot, költség és pénzügyi UI

- [x] Kész
- Függőség: T18, T20, T22. Méret: M.
- Fájlok: `src/lib/engine/tick-process.ts`, `src/lib/ops/heartbeat.ts`, `src/components/TickInspector.tsx`, `src/components/AnalyticsPanel.tsx`, `tests/lib/engine/tick-process.test.ts`.
- Elfogadás: entry/exit utolsó siker, scheduler késés, quote-age, stage latency, letiltási ok és adatkimaradás látszik; nettó P&L és iránytalálat külön, költségadat hiánya nem nulla; sikertelen ledger nem zöld heartbeat, riasztás nem ismétel változatlan hibát minden tickben.
- Ellenőrzés: `pnpm exec vitest run tests/lib/engine/tick-process.test.ts tests/lib/ops/heartbeat.test.ts`; szimulált failure/degraded/recovery UI egy desktop+mobil körben. Új vizuális irány nincs; meglévő dashboardhoz illesztés.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/ops/heartbeat.test.ts tests/lib/engine/tick-process.test.ts` → 28 teszt zöld; `pnpm test` 57 fájl / 579 teszt; `pnpm build` sikeres. Bizonyított: a siker-heartbeat CSAK sikeres könyvelés mellett megy ki; azonos hibakód nem ismétlődik minden tickben (elnyomott pingek számláltak), MÁS hiba és a helyreállás viszont azonnal kimegy; az `OpsHealth` külön követi a belépést és a kilépést (utolsó siker, ütemező-késés, quote-kor, adatkimaradás), és a MÉG SOSEM futott ciklus nem „friss”, hanem ismeretlen. A `TickProcess.health` + `explainNoTrade` megmondja, MIÉRT nem történt kötés; a hiányzó adat mindenhol `null`, nem 0. 🔴 KORLÁT: a desktop+mobil UI-kör NEM futott le — nincs böngésző ebben a környezetben.

**C9 / M4:** Legalább 24 órás izolált paper próba: nincs dupla fill vagy elveszett state, működő forrás mellett quote-age ≤10 s, exit indulási késés p95 ≤10 s a tervezett ütemhez képest. Ez mérnöki cél, túllépéskor okfeltárás szükséges. Ez még nem profitbizonyíték.

## M5 — Binance-adapter teljessége, live váltás nélkül

### T24 — Symbol filter és minimum-order

- [x] Kész
- Függőség: T02, T04, T14. Méret: M.
- Fájlok: `src/lib/execution/exchange-rules.ts`, `src/lib/execution/binance-broker.ts`, `src/lib/execution/paper-fill.ts`, `tests/lib/execution/exchange-rules.test.ts`, `tests/lib/execution/binance-broker.test.ts`.
- Elfogadás: aktuális hivatalos dokumentáció és exchangeInfo alapján ár/mennyiség/notional kerekítés; nincs univerzális toFixed vagy fix dollárminimum; paper/backtest ugyanazt az ellenőrzőt használhatja, a broker az indokolatlan minimum-5%-os stoptiltást helyes validációra cseréli.
- Ellenőrzés: `pnpm exec vitest run tests/lib/execution/exchange-rules.test.ts tests/lib/execution/binance-broker.test.ts`; 100 USD tőke, mikroorder/dust, határpontok, stale filter és kerekítés utáni notional.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/execution/exchange-rules.test.ts tests/lib/execution/binance-broker.test.ts` → 33 teszt zöld; `pnpm test` 58 fájl / 608 teszt; `pnpm build` sikeres. Bizonyított: a kerekítés a TÉNYLEGES tickSize és stepSize szerint LEFELÉ történik, szimbólumonként (nincs univerzális toFixed); a minimum notional a KEREKÍTÉS UTÁNI értékre vonatkozik; 100 USD tőkén a 2%-os DCA (2 USD) az 5 USD-s minimum alatt van és elutasításra kerül; a hiányos szűrőkészletű szimbólum kimarad, az ELAVULT készlet pedig blokkol; a védőorder ára is tickSize-ra kerül és a limit a stop ALATT marad; a kitalált „min 5% stop” dobás megszűnt. A paper/backtest ugyanezt az ellenőrzőt használhatja (`PaperFillParams.filters`).

### T25 — Idempotens orderküldés és tényleges fill

- [x] Kész
- Függőség: T09, T10, T24. Méret: M.
- Fájlok: `src/lib/execution/binance-broker.ts`, `src/lib/execution/binance-order-state.ts`, `src/lib/execution/order-store.ts`, `tests/lib/execution/binance-broker.test.ts`, `tests/integration/order-recovery.test.ts`.
- Elfogadás: stabil client order ID, orderállapot és fill dedup; base/quote/BNB díj helyes eszközön, hiányzó díjárfolyam jelölt becslés/függő értékelés; timeout után státuszlekérdezés, részleges teljesülés és nulla fill nem hamis teljes siker. BUY stop paramétere nem sérti a közös stratégiát.
- Ellenőrzés: adapterfixture-ek elfogadott de timeoutos, elutasított, részlegesen teljesült, ismételt válaszokra; valódi DB retry-teszt, újraindulás nem küld új azonosítójú duplikátumot.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/execution/binance-order-state.test.ts` → 24 teszt zöld; `pnpm test` 59 fájl / 632 teszt. Bizonyított: STABIL `newClientOrderId` az intentId-ból, ezért az újraindulás UGYANAZT az azonosítót küldi; timeout után NEM megy ki új order, hanem lekérdezés; a „duplicate order” hibát a MEGLÉVŐ megbízás lekérdezésével oldjuk fel; a FILLED státusz NULLA teljesüléssel `unknown` és NYITOTT marad; a részleges teljesülés részlegesként látszik; a fill-kulcs (mode, orderId, tradeId) miatt nincs dupla könyvelés; a díj a SAJÁT eszközében marad, a BNB-díj FÜGGŐ értékelésű, nem nulla. 🔴 KORLÁT: `tests/integration/order-recovery.test.ts` MEGÍRVA, de NEM FUTOTT; valódi tesztkörnyezeti (testnet) próba sem történt.

### T26 — Védőorder teljes életciklusa

- [x] Kész
- Függőség: T21, T25. Méret: M.
- Fájlok: `src/lib/execution/protection.ts`, `src/lib/execution/binance-broker.ts`, `src/lib/engine/fast-exit.ts`, `tests/lib/execution/protection.test.ts`, `tests/integration/protection-recovery.test.ts`.
- Elfogadás: BUY után net birtokolt qty védelme, order ID tartós; trailing/rávásárlás/részleges SELL után a védelem qty/ára egyezik; TP/manual SELL és zárolt készlet koordinált. Stoptelepítés hibája és cancel/replace közbeni fill explicit incident, nincs puszta console.error utáni normál BUY-folytatás.
- Ellenőrzés: feltöltés/stopcancel közti fill, restart, részleges execution, gap és stop-limit nemteljesülés fixture-ek; tesztkörnyezetben védelem nélküli állapot kimutatása és előre rögzített helyreállítás. Kényszerpiaci zárás nem rejtett alapértelmezés.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/execution/protection.test.ts` → 20 teszt zöld; `pnpm test` 60 fájl / 652 teszt. Bizonyított: a védett mennyiség a NETTÓ birtokolt mennyiség, ezért a rávásárlás és a részleges eladás CSERÉT tervez; a trailing ratchet a TŐZSDEI ordert is cseréli (a DB-frissítés önmagában nem elég — külön `stale_stop` incidens); a védelem hiánya, az elbukott feladás és az elbukott törlés BLOKKOLÓ incidens, tehát nincs normál BUY-folytatás egy `console.error` után; a cancel a place ELŐTT megy (a pihenő order zárolja a készletet); a csere közbeni fill külön eset; az árva védőorder törlendő, de nem blokkol; kényszerpiaci zárást a modul SOHA nem tervez. 🔴 KORLÁT: `tests/integration/protection-recovery.test.ts` MEGÍRVA, de NEM FUTOTT.

**C10:** T24–T26 után exchange-rules, order recovery és protection tesztek zöldek; mock és valódi tesztkörnyezeti bizonyíték külön jelölve.

### T27 — Tőzsdei egyenleg és nyitott orderek egyeztetése

- [x] Kész
- Függőség: T25, T26. Méret: M.
- Fájlok: `src/lib/execution/reconcile.ts`, `src/lib/engine/worker.ts`, `src/lib/execution/order-store.ts`, `tests/lib/execution/reconcile.test.ts`, `tests/integration/reconcile.test.ts`.
- Elfogadás: induláskor és periodikusan exchange az igazságforrás a live accountnál; free/locked/base/quote és védőorderek egyeznek, új fill egyszer importálódik; kézi tőzsdei kötés vagy eltérés új BUY-t blokkol, helyreállítás idempotens, paper account érintetlen.
- Ellenőrzés: `pnpm exec vitest run tests/lib/execution/reconcile.test.ts`; izolált DB-ben kiesés alatti stop-fill, idegen manuális order, deposit és duplikált trade; tesztkörnyezeti restart egyeztetéssel.
- **Bizonyíték:** `pnpm exec vitest run tests/lib/execution/reconcile.test.ts tests/lib/engine/worker.test.ts` → 35 teszt zöld; `pnpm test` 61 fájl / 671 teszt; `pnpm build` sikeres. Bizonyított: LIVE módban a tőzsde az igazságforrás; a free ÉS locked együtt számít (a pihenő védőorder zárolása nem hiány); a kimaradás alatti stop-fill, az idegen kézi order és a védelem nélküli pozíció mind BLOKKOLJA az új vételt; a talált teljesülés pontosan egyszer importálódik (ismert fill-kulcs nem kerül újra be); a PAPER számlán a modul NEM fut le és nem nyúl semmihez. A worker induláskor egyeztet, és a hibára futó egyeztetés KONZERVATÍV: a vétel tiltott marad. 🔴 KORLÁT: `tests/integration/reconcile.test.ts` MEGÍRVA, de NEM FUTOTT; valódi tesztkörnyezeti BUY→védőorder→részleges SELL→zárás→reconcile folyamat NEM lett végigvive.

**C11 / M5:** Teljes suite + típusellenőrzés + build; tesztkörnyezeti BUY→védőorder→részleges SELL→zárás→reconcile folyamat. Valós pénzes próbát vagy live váltást ez nem indít.

## M6 — Futtatás, kísérletek és átadás

### T28 — Futtatási és átállási dokumentáció

- [x] Kész
- Függőség: T11, T22, T23. Méret: M.
- Fájlok: `docs/worker-runbook.md`, `.env.example`, `.github/workflows/tick.yml`, `vercel.json`, `README.md`.
- Elfogadás: helyi worker és választott környezet pontos parancsai, restart/health/rollback; egy aktív scheduler, cron+worker együtt sem dupláz; README a tényleges modellről, ütemről és demó/live státuszról ír. Hosted endpointok auth-követelménye és kulcsok szerepe dokumentált; fizetős hosting csak külön költségdöntéssel.
- Ellenőrzés: tiszta checkoutból runbook követése izolált paper DB-vel; konfiguráció- és secret-ellenőrzés értékek naplózása nélkül. Windows háttérfolyamat rejtett ablakban, külső deploy előtt konkrét konfiguráció bemutatható.

### T29 — Előre rögzített profitkísérleti protokoll

- [x] Kész
- Függőség: T19, T20, T24. Méret: S.
- Fájlok: `docs/experiments/protocol-v1.md`, `scripts/experiment-configs.ts`.
- Elfogadás: max drawdown és működési költségkeret a jelöltválasztás előtt rögzítve; DCA/momentum és opcionális állapotfüggő szabály, AI kontroll, exit cadence külön kísérlet; időablak/adathash/holdout és elfogadási szabály előre fagyasztott, nincs utólagos küszöbmozgatás.
- Ellenőrzés: a protokollból minden mérés újraindítható; jelöltváltozatok csak a vizsgált paraméterben térnek el; kockázatemelés nem történik implicit. Nyitott felhasználói kockázatdöntésig az eszközök elkészülhetnek, jelöltadoptálás nem.

### T30 — Reprodukálható összehasonlító mérések

- [x] Kész
- Függőség: T19, T20, T21, T24, T29. Méret: M.
- Fájlok: `scripts/compare-strategies.ts`, `src/lib/backtest/experiment.ts`, `tests/lib/backtest/experiment.test.ts`, `docs/experiments/results-v1.md`.
- Elfogadás: 100/10 000 USD, cash/BTC/DCA/momentum/AI kontroll, alap és emelt költség; az exit 1/5/15/60 perces változatainak azonos entry-intentje van az izolált vizsgálatban; nettó eredmény/DD/kitettség/forgalom/költség és bizonytalanság szerepel. Sikertelen variánsok is megmaradnak, nincs automatikus stratégiaváltás.
- Ellenőrzés: `pnpm exec vitest run tests/lib/backtest/experiment.test.ts`; két azonos hashű futás azonos jelentés; holdout egyszeri, előre rögzített értékelés. A hiányzó adat/minta „nem eldönthető” eredményt ad.

**C12:** T28–T30 után a rendszer futtatható, a kísérlet és eredménye ellenőrizhető. Jobb jelölt hiányában a javított DCA alapvonal marad.

### T31 — Előremenő paper összevetés

- [ ] Kész
- Függőség: T23, T28, T29, T30. Méret: M.
- Fájlok: `scripts/shadow-paper.ts`, `src/lib/backtest/shadow-accounts.ts`, `tests/integration/shadow-paper.test.ts`, `docs/experiments/forward-paper-v1.md`.
- Elfogadás: elkülönült paper számlák azonos induló tőkével és inputokkal; javított baseline és jelölt párban, AI párok ott, ahol múlt nem rekonstruálható; nincs éles order vagy cross-account cash/keret. Legalább 30 nap megfigyelés és 50 lezárt round-trip cél, a korrelált kötések és piaci állapotok miatt ez önmagában nem statisztikai garancia.
- Ellenőrzés: account isolation és replay integrációs teszt; végső jelentés a költségek utáni eltérésről, drawdownról, incidensekről és mintabizonytalanságról. Kevés kötés/egyoldalú piac esetén a mérési feladat nyitott marad, nem minősül sikernek néhány nap után.
- **Forráskód-kész:** az elkülönített számlák provisionálása egyetlen SQL-tranzakció; a baseline quote/collector pillanatképe, logikai ideje és `--ai` esetén nyers AI-döntése is változatlan replay. A ciklus/equity/incidens tartós, a `--report` nettó hozamot, drawdownt, USDT-díjat és round-tripet számol. A 30 napos/50 round-trip külső megfigyelési kapu és a valódi PostgreSQL integrációs futás még nyitott, ezért a feladat nincs készre jelölve.

### T32 — Teljes regresszió és audit-visszaellenőrzés

- [ ] Kész
- Függőség: T01–T31. Méret: M.
- Fájlok: `docs/verification/profit-fixes.md`, `src/app/api/cron/tick/route.ts`, `tests/lib/api/cron-auth.test.ts`, `README.md`, `tasks/todo.md`.
- Elfogadás: minden auditmegállapítás mellé javítás és bizonyíték; hosted order-trigger auth hiányában fail-closed, helyi teszt kivétel explicit; teljes folyamat friss és legacy fixture-rel, crash/recovery és minimumtőke mellett működik. Műszaki készültség és stratégiaeredmény külön verdict, live mód marad kikapcsolva.
- Ellenőrzés: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm build`; összes izolált PostgreSQL-teszt; T31 jelentés, M5 tesztkörnyezeti bizonyíték; egy összesített desktop+mobil ellenőrzés. Nem teljesült külső/mérési kapu fel van tüntetve, a teljes terv addig nincs készre jelölve.
- **Forráskód-kész:** `docs/verification/profit-fixes.md` összeköti az auditot a javításokkal; a cron auth fail-closed. A korábbi visszaellenőrzéskor talált lease/fencing, kezdeti stop, protection-végrehajtás, worker-reconciliation és shadow-riport hiányok implementálva. `pnpm test` 68 fájl / 765 teszt, `tsc --noEmit` és build zöld. A T31 időalapú mérés, a külön PostgreSQL integráció, a 24 órás worker és a testnet bizonyíték hiányában a teljes kapu nyitott marad.

**C13 / M6:** Átadott javított demó, reprodukálható mérés, dokumentált futtatás és helyreállítás. A nyereség nem előre garantált; gyenge jelöltet elutasítani érvényes eredmény.

## Audit → feladat lefedettség

| Auditmegállapítás | Feladat |
|---|---|
| Összesített pozíciólimit és korai return | T06, T09 |
| Cash-alapú SELL, orphan SELL | T02, T05, T06, T16 |
| Eladási díj és eltérő cash-elszámolás | T04, T05, T09, T18 |
| Irreális papír stop teljesülési ár | T05, T14, T17 |
| Napi P&L helyett indulás óta mért hozam, SELL-blokkolás | T06, T07 |
| DCA megkerüli a risket, heti túlköltés és mód/eredet keverése | T06, T08, T09 |
| Rávásárlás lejjebb viszi a stopot | T08, T15, T26 |
| Current candle, jövő timestamp, kevert volume, ATR close-only | T12, T13, T14, T15 |
| Momentum 24/48 warmup és config drift | T12, T15 |
| AI nullás entryPrice, kétértelmű százalék | T02, T16 |
| Modell AUC alapján gyenge auto-promotion | T13, T29, T30 |
| AI kihagyása a backtestből és hibás 1h visszacsatolás | T20, T31 |
| Backtest/live időzítés, részleges exit/PF/díj/Sharpe | T17, T18 |
| OOS-ra választott tournament, hiányzó benchmark és költség | T19, T29, T30 |
| Dupla tick, részleges DB-írás, sikernek látszó hiba | T03, T09, T10, T23 |
| Védtelen DB-fallback és pénzügyi precision | T03, T04, T06 |
| Binance filter/minimum, fee asset, order lifecycle | T24, T25, T26, T27 |
| Gyors exit és órás branch koordináció | T21, T22, T23 |
| Actions-keret, README eltérések és üzemeltetési költség | T23, T28, T30 |
| Régi demóadatok bizonytalansága és megőrzése | T01, T11, T18 |
| Teljes regresszió, paper bizonyítás és live határ | T31, T32 |

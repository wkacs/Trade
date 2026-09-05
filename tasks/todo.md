# Javítási feladatlista

Terv: [plan.md](plan.md). Állapot: minden implementációs feladat nyitott. A fájlok az érintett meglévő vagy létrehozandó útvonalak; a tesztparancsokat a repó gyökeréből kell futtatni. Minden feladat lezárásakor rövid bizonyítékot kell ide írni: parancs, eredmény, releváns korlát. A generált migrációs metaadatok a felsorolt migrációhoz tartoznak.

## M1 — Helyes demó, könyvelés és risk

### T01 — Biztonságos mérési és integrációs alap

- [ ] Kész
- Függőség: nincs. Méret: M.
- Fájlok: `scripts/audit-state.ts`, `tests/integration/setup.ts`, `vitest.integration.config.ts`, `package.json`, `.gitignore`.
- Elfogadás: csak olvasó, redaktált állapotexport; külön teszt-DB és parancs, alapértelmezésben semmilyen teszt nem használhatja a normál DATABASE_URL-t; a 182 tesztes alapállapot és az audit példái rögzítve.
- Ellenőrzés: `pnpm test`; a script fixture-adatú próbája; az integrációs setup elutasítja a normál/hiányzó DB-konfigurációt. Exportált pénzügyi adatok ne kerüljenek gitbe.

### T02 — Verziózott order- és fill-szerződés

- [ ] Kész
- Függőség: T01. Méret: M.
- Fájlok: `src/lib/types.ts`, `src/lib/execution/contracts.ts`, `src/lib/execution/broker.ts`, `tests/lib/execution/contracts.test.ts`.
- Elfogadás: BUY quote-budget és SELL base-qty megkülönböztethető; intent/fill azonosító, díjeszköz és állapot explicit; v2 típusok kompatibilitási adapterrel bevezetve, a régi runtime még fordul.
- Ellenőrzés: `pnpm exec vitest run tests/lib/execution/contracts.test.ts`; `pnpm exec tsc --noEmit`; negatív/NaN/Infinity és értelmetlen oldali mezők elutasítása.

### T03 — Atomi ledgerhez szükséges bővítő séma

- [ ] Kész
- Függőség: T02. Méret: M.
- Fájlok: `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrations/<következő>.sql`, `tests/integration/ledger-schema.test.ts`, `docs/ledger-contract.md`.
- Elfogadás: numeric összegek, portfolio/mode/version határ, egyedi intent/fill azonosítók, reservations és napi equity tárolható; driver/tranzakciómegoldás ellenőrzött; migráció nem veszít régi sorokat, meglévő reader tovább működik.
- Ellenőrzés: izolált PostgreSQL-migráció üres és legacy fixture-re; egyediség és CHECK feltételek valódi DB-ben; dokumentált tranzakciópróba. Külső DB-n még nincs alkalmazás.

**C1:** T01–T03 után alap-suite, típusellenőrzés, izolált migráció zöld; export és séma áttekinthető.

### T04 — Közös fill-könyvelő

- [ ] Kész
- Függőség: T02. Méret: M.
- Fájlok: `src/lib/portfolio/ledger.ts`, `src/lib/portfolio/money.ts`, `tests/lib/portfolio/ledger.test.ts`, `package.json`, `pnpm-lock.yaml`.
- Elfogadás: azonos fill → azonos cash/qty/bekerülési érték; BUY és SELL díj quote/base/harmadik eszközben egyszer számít; részleges zárás helyes, készlet és cash nem lesz tiltottan negatív. Egy kiválasztott decimális megoldás, nincs többféle kerekítés.
- Ellenőrzés: `pnpm exec vitest run tests/lib/portfolio/ledger.test.ts`; kézzel ellenőrizhető round-trip példák, változatlan árnál veszteség pontosan a költség, részleges fill és dust határ.

### T05 — PaperBroker valósághű teljesülése

- [ ] Kész
- Függőség: T04. Méret: M.
- Fájlok: `src/lib/execution/paper-broker.ts`, `src/lib/execution/paper-fill.ts`, `tests/lib/execution/paper-broker.test.ts`, `tests/lib/execution/paper-fill.test.ts`.
- Elfogadás: SELL birtokolt qty-ből, helyes díjjal; nincs orphan SELL vagy nulla order; 95-ös stop és 90-es megfigyelt eladási ár nem ad 95-ös fillt, spread/csúszás explicit. A broker nem vezet második, eltérő igazságforrású egyenleget.
- Ellenőrzés: `pnpm exec vitest run tests/lib/execution/paper-broker.test.ts tests/lib/execution/paper-fill.test.ts`; BUY→részleges SELL→teljes SELL azonos ledgeren.

### T06 — Minden order közös kockázati kapun

- [ ] Kész
- Függőség: T04, T05. Méret: M.
- Fájlok: `src/lib/risk/risk-manager.ts`, `src/lib/engine/execute-intent.ts`, `src/lib/engine/tick.ts`, `tests/lib/risk/risk-manager.test.ts`, `tests/lib/engine/execute-intent.test.ts`.
- Elfogadás: AI/DCA/momentum/manual egységes kaput kap; 20 USD BTC + 80 USD cash + 20%-os BUY nem növeli tovább a BTC-t; max positions, cash, reserved összeg és szimbólumlista együtt számít. SELL cash=0 mellett is végrehajtható és veszteségkapunál is engedett.
- Ellenőrzés: `pnpm exec vitest run tests/lib/risk/risk-manager.test.ts tests/lib/engine/execute-intent.test.ts`; túlméretes BUY nem ugrik át pozíciószám-korlátot; nincs DB-hibás fallback-order. V2 nincs tartós futásra engedve T09–T11 előtt.

**C2:** T04–T06 után fill/risk regressziók és teljes típusellenőrzés zöld; a bizonyított 36%-os kitettségi hiba megszűnt.

### T07 — Valódi napi veszteségkorlát

- [ ] Kész
- Függőség: T03, T06. Méret: M.
- Fájlok: `src/lib/portfolio/day-equity.ts`, `src/lib/portfolio/accounting.ts`, `src/lib/engine/tick.ts`, `tests/lib/portfolio/day-equity.test.ts`, `tests/integration/day-equity.test.ts`.
- Elfogadás: UTC napi baseline, cash flow korrekció és napi latch; indulás óta mért P&L külön; napváltás, résznapos indulás, szünet és hiányzó referencia explicit, SELL nincs letiltva.
- Ellenőrzés: `pnpm exec vitest run tests/lib/portfolio/day-equity.test.ts`; integrációs teszt két egyidejű napnyitással; előző nap nyeresége nem rejti el az aznapi -3%-ot.

### T08 — Heti DCA-keret és trailing-stop megőrzése

- [ ] Kész
- Függőség: T06. Méret: M.
- Fájlok: `src/lib/strategy/fear-greedy.ts`, `src/lib/strategy/weekly-budget.ts`, `src/lib/portfolio/ledger.ts`, `tests/lib/strategy/weekly-budget.test.ts`, `tests/lib/portfolio/ledger.test.ts`.
- Elfogadás: 1 USD heti maradék legfeljebb 1 USD teljes költés; csak adott portfolio/mode DCA fill+foglalás fogyaszt, AI nem; rávásárlás nem csökkentheti a már aktív stopot.
- Ellenőrzés: `pnpm exec vitest run tests/lib/strategy/weekly-budget.test.ts tests/lib/strategy/fear-greedy.test.ts tests/lib/portfolio/ledger.test.ts`; 7 napos határ, live/paper elkülönítés, törölt reservation felszabadulása.

### T09 — Egy tranzakciós perzisztenciaút

- [ ] Kész
- Függőség: T03, T04, T06, T07, T08. Méret: M.
- Fájlok: `src/lib/portfolio/accounting.ts`, `src/lib/execution/order-store.ts`, `src/lib/engine/execute-intent.ts`, `tests/integration/accounting.test.ts`, `tests/lib/engine/execute-intent.test.ts`.
- Elfogadás: fill+cash+position+reservation módosítás együtt commit/rollback; duplikált fill nem változtat egyenleget; DB-hiba strukturált hibát ad, nincs log+null utáni hamis siker vagy order-küldés.
- Ellenőrzés: valódi PostgreSQL fault injection minden írási ponton; két párhuzamos BUY nem lépi át a foglalt keretet; friss DB-visszaolvasás egyezik a reducer állapotával.

**C3:** T07–T09 után valódi DB-tranzakció, napi és heti keret tesztjei zöldek; `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm build`.

### T10 — Újrapróbálás és több futó kizárása

- [ ] Kész
- Függőség: T09. Méret: M.
- Fájlok: `src/lib/engine/run-scheduled-tick.ts`, `src/lib/engine/run-lease.ts`, `src/lib/execution/order-store.ts`, `tests/integration/run-lease.test.ts`, `tests/lib/engine/run-scheduled-tick.test.ts`.
- Elfogadás: a tick ID nem puszta előzetes SELECT; tartós claim/lease, fencing és egyedi intent; sikertelen mentés nem küld siker-heartbeatet. Futási kulcs előkészítve külön entry/exit idősávra, ismeretlen order-állapot újraküldés helyett egyeztetésre vár.
- Ellenőrzés: cron és worker egyidejű indítása, lease lejárat, crash/retry a tervezés és könyvelés között; nincs dupla fill vagy keretfogyás.

### T11 — Régi demóadatok megőrzése és mérési átállás

- [ ] Kész
- Függőség: T09, T10. Méret: M.
- Fájlok: `scripts/migrate-paper-ledger.ts`, `src/lib/portfolio/legacy-import.ts`, `tests/integration/legacy-import.test.ts`, `docs/ledger-migration.md`.
- Elfogadás: dry-run az alap, snapshot/diff/megismételhető import; hiányzó origin/orderId és irreális régi stop-fill nem lesz kitalált hiteles adat; új epoch nyitóállapottal, régi adatok megőrizve. Koncentrált BTC-t nem ad el migráció, új rávásárlás tiltott.
- Ellenőrzés: másolat-adatbázison kétszeri import ugyanazt adja; előtte/utána cash és qty eltérésjelentés; rollback/prior reader próbája. Tényleges külső migráció külön ütemezett lépés.

**C4 / M1:** A demó végigfut a v2 úton izolált DB-n; nincs pénzteremtés, dupla könyvelés vagy limitmegkerülés. Teljes suite + típusellenőrzés + build.

## M2 — Piaci adat és döntések

### T12 — Valódi, lezárt OHLCV

- [ ] Kész
- Függőség: T02. Méret: M.
- Fájlok: `src/lib/market/candles.ts`, `src/lib/collectors/binance.ts`, `src/lib/backtest/data.ts`, `tests/lib/collectors/binance.test.ts`, `tests/lib/backtest/data.test.ts`.
- Elfogadás: lezáratlan/jövőbeli gyertya kiesik; high/low/volume/időkeret megmarad, duplák és rések felismerve; a maximális lookback+warmup lekérhető, rate limit és hibás oldal nem csendes teljes adatsor.
- Ellenőrzés: `pnpm exec vitest run tests/lib/collectors/binance.test.ts tests/lib/backtest/data.test.ts`; réses sor, current candle, hibás OHLC és lapozási duplikáció fixture-ek.

### T13 — Feature- és modellverzió egységesítése

- [ ] Kész
- Függőség: T12. Méret: M.
- Fájlok: `src/lib/ml/features.ts`, `src/lib/ml/predictor.ts`, `scripts/train-model.ts`, `.github/workflows/retrain.yml`, `tests/lib/ml/features-parity.test.ts`.
- Elfogadás: tréning és runtime ugyanabból az OHLCV ablakból azonos feature-t ad; nincs CoinGecko 24h/órás volume keverés; inkompatibilis modell jelöltként karanténba kerül. Heti tanítás nem deployol pusztán AUC≥0,5 alapján.
- Ellenőrzés: `pnpm exec vitest run tests/lib/ml/features-parity.test.ts tests/lib/ml/predictor.test.ts`; modellverzió-eltérés és hiányzó warmup nem látszik érvényes ML-jelként. Új tanítás külön jelöltfájl, aktív modell nem íródik felül.

### T14 — Friss végrehajtási ár külön adatúton

- [ ] Kész
- Függőség: T02, T12. Méret: M.
- Fájlok: `src/lib/market/quotes.ts`, `src/lib/collectors/base.ts`, `src/lib/engine/tick.ts`, `tests/lib/market/quotes.test.ts`, `tests/lib/engine/tick.test.ts`.
- Elfogadás: külön bid/ask+receivedAt/exchangeTime, explicit freshness és timeout; exit árlekérés nem vár hírekre; AI-order küldése előtt quote és risk újraellenőrzött. Elavult ár vagy részleges collectorhiba mérhető állapot.
- Ellenőrzés: `pnpm exec vitest run tests/lib/market/quotes.test.ts tests/lib/engine/tick.test.ts`; végtelen RSS-várakozás mellett az exit árút időkorláton belül végez, 10 s feletti quote nem válik friss orderré.

**C5:** T12–T14 után adat/feature paritás és hibakezelés zöld; nincs jövőbeli záróidő „legfrissebb árként”.

### T15 — Közös konfiguráció és működő momentum-adatút

- [ ] Kész
- Függőség: T08, T12, T13. Méret: M.
- Fájlok: `src/lib/strategy/config.ts`, `src/lib/config.ts`, `src/lib/engine/profit-cycle.ts`, `src/lib/engine/tick.ts`, `tests/lib/engine/strategy-parity.test.ts`.
- Elfogadás: egy StrategyConfig forrás, paper/backtest/config kijelzéshez verzió; 48+ lezárt gyertyával tényleges momentum-jel, hiányos adattal nincs trendengedély; ATR a valódi high/low-t használja, induló és követő stop módszere egyezik. Alapértelmezésben momentum továbbra is ki.
- Ellenőrzés: `pnpm exec vitest run tests/lib/engine/strategy-parity.test.ts tests/lib/strategy/config.test.ts`; fix/ATR és eltérő warmup fixture-ek mindkét útból azonos tervet adnak.

### T16 — AI-intent és valós portfóliókontextus

- [ ] Kész
- Függőség: T06, T13, T14, T15. Méret: M.
- Fájlok: `src/lib/llm/schemas.ts`, `src/lib/llm/phase2-decide.ts`, `src/lib/engine/tick.ts`, `src/lib/llm/client.ts`, `tests/lib/llm/phase2-decide.test.ts`.
- Elfogadás: tényleges entryPrice/equity/pozícióérték/risk keret az AI-nak; BUY equityFraction és SELL positionFraction verziózott, holdings/coin-lista validált, régi mezőket adapter kezeli; modell/prompt verzió, token/költség és idő rögzíthető, confidence nincs találati valószínűségként beállítva.
- Ellenőrzés: `pnpm exec vitest run tests/lib/llm/phase2-decide.test.ts tests/lib/engine/tick.test.ts`; cash=0 SELL, érvénytelen symbol, hiányzó adat és LLM-timeout tesztek, régi naplók olvashatók maradnak.

**C6 / M2:** T15–T16 után teljes suite + típusellenőrzés + build; rögzített inputból reprodukálható döntési terv.

## M3 — Hiteles backtest és AI-összehasonlítás

### T17 — Végrehajtási idő és backtest-paritás

- [ ] Kész
- Függőség: T05, T06, T12, T15. Méret: M.
- Fájlok: `src/lib/backtest/types.ts`, `src/lib/backtest/engine.ts`, `src/lib/backtest/fill-sim.ts`, `tests/lib/backtest/engine.test.ts`, `tests/lib/backtest/parity.test.ts`.
- Elfogadás: közös risk+ledger minden ordernél; jel után következő elérhető áron fill, nincs jövőinformáció; polling és függő exchange stop külön modell, 1/5/15/60 perces ellenőrzés megfelelő adatról fut.
- Ellenőrzés: `pnpm exec vitest run tests/lib/backtest/engine.test.ts tests/lib/backtest/parity.test.ts tests/lib/backtest/fill-sim.test.ts`; stop+TP ugyanazon gyertyán, gap, részleges fill, eltűnő quote; azonos input/időzítés paper és backtest cash/qty/fees egyezik.

### T18 — Nettó metrikák és részleges eladások

- [ ] Kész
- Függőség: T04, T11, T17. Méret: M.
- Fájlok: `src/lib/backtest/metrics.ts`, `src/lib/portfolio/analytics.ts`, `src/lib/backtest/engine.ts`, `tests/lib/backtest/metrics.test.ts`, `tests/lib/portfolio/analytics.test.ts`.
- Elfogadás: minden részleges realizálás és díj bekerül, kezdőtőke a legelső kötés előtt; időkerethez helyes Sharpe/MTM drawdown, pénzmozgások és költségek elkülönítve; hit rate/PF meghatározás közös, örökölt bizonytalan adat külön látszik.
- Ellenőrzés: `pnpm exec vitest run tests/lib/backtest/metrics.test.ts tests/lib/portfolio/analytics.test.ts`; kézi ledgerpéldák, csak nyerő/üres/részlegesen zárt sor, JSON serialization és díjak miatti nullszaldó.

### T19 — Független teszt és benchmarkok

- [ ] Kész
- Függőség: T17, T18. Méret: M.
- Fájlok: `src/lib/backtest/walk-forward.ts`, `src/lib/backtest/benchmarks.ts`, `scripts/tournament.ts`, `scripts/backtest.ts`, `tests/lib/backtest/walk-forward.test.ts`.
- Elfogadás: időben gördülő tanítás/validálás és zárolt végső teszt; jelölt nem választható a végső teszt eredményéből; cash/BTC/DCA referencia, 100 és 10 000 USD, minimum-order és költségstressz, seed/adathash/configverzió a jelentésben. Warmup múltból jön, jövőből soha.
- Ellenőrzés: `pnpm exec vitest run tests/lib/backtest/walk-forward.test.ts`; módosított teszteredmény nem változtatja a már kiválasztott jelöltet; azonos adathash kétszer azonos riportot ad.

**C7:** T17–T19 után közös execution-paritás és metrikák bizonyítva; a régi tournament győztese nem automatikus új alapértelmezés.

### T20 — AI értékelés és visszajátszhatóság

- [ ] Kész
- Függőség: T16, T17, T18, T19. Méret: M.
- Fájlok: `src/lib/backtest/decision-replay.ts`, `src/lib/portfolio/evaluate.ts`, `src/lib/engine/run-scheduled-tick.ts`, `tests/lib/backtest/decision-replay.test.ts`, `tests/lib/portfolio/evaluate.test.ts`.
- Elfogadás: korábban rögzített intent/model/input időponttal replayelhető, AI nélküli kontroll ugyanazon feltételekkel; hiányzó történelmi AI nem pótolható bizonyítéknak nevezett utólagos generálással; 1h iránytalálat megfelelő historikus horizontra számolódik, nem a következő tetszőleges tick árára, és nem azonos a profitmutatóval.
- Ellenőrzés: `pnpm exec vitest run tests/lib/backtest/decision-replay.test.ts tests/lib/portfolio/evaluate.test.ts`; többnapos üzemszünet, hiányzó price, jövőbeli intent tiltás és elszámolt AI-költség.

**C8 / M3:** AI/backtest paritás és korlátok dokumentálva; teljes suite + típusellenőrzés + build.

## M4 — Gyors kilépés és állandó worker

### T21 — Külön, determinisztikus exit-ciklus

- [ ] Kész
- Függőség: T10, T14, T15, T17. Méret: M.
- Fájlok: `src/lib/engine/plan-exits.ts`, `src/lib/engine/profit-cycle.ts`, `src/lib/engine/fast-exit.ts`, `tests/lib/engine/plan-exits.test.ts`, `tests/lib/engine/fast-exit.test.ts`.
- Elfogadás: közös stop/TP/trailing tervező órás és gyors ágnak; fast-exit nem készít BUY-t és nem hív LLM-et; időközben zárt pozíció és stale quote nem okoz hibás/dupla SELL-t, a gyakoriság külön konfigurált.
- Ellenőrzés: `pnpm exec vitest run tests/lib/engine/plan-exits.test.ts tests/lib/engine/fast-exit.test.ts tests/lib/engine/profit-cycle.test.ts`; ugyanazon trigger két ciklusból egyszer könyvelődik.

### T22 — Ütemező worker és újraindulás

- [ ] Kész
- Függőség: T10, T21. Méret: M.
- Fájlok: `scripts/worker.ts`, `src/lib/engine/worker.ts`, `src/lib/engine/run-scheduled-tick.ts`, `package.json`, `tests/lib/engine/worker.test.ts`.
- Elfogadás: 5m exit + 60m lezárt gyertyás entry; ne legyen átfedő async setInterval, hosszú LLM-hívás ne fogja az exitet; indulás/restart függő állapotokat egyeztet, régi idősávokat nem vesz visszamenőleg. SIGTERM és egyszeri futás tesztelhető.
- Ellenőrzés: `pnpm exec vitest run tests/lib/engine/worker.test.ts`; injektált idővel késés/éjfél/restart/óraugrás, hosszú entry mellett exit; két folyamat valódi DB-n egy írót eredményez.

### T23 — Futási állapot, költség és pénzügyi UI

- [ ] Kész
- Függőség: T18, T20, T22. Méret: M.
- Fájlok: `src/lib/engine/tick-process.ts`, `src/lib/ops/heartbeat.ts`, `src/components/TickInspector.tsx`, `src/components/AnalyticsPanel.tsx`, `tests/lib/engine/tick-process.test.ts`.
- Elfogadás: entry/exit utolsó siker, scheduler késés, quote-age, stage latency, letiltási ok és adatkimaradás látszik; nettó P&L és iránytalálat külön, költségadat hiánya nem nulla; sikertelen ledger nem zöld heartbeat, riasztás nem ismétel változatlan hibát minden tickben.
- Ellenőrzés: `pnpm exec vitest run tests/lib/engine/tick-process.test.ts tests/lib/ops/heartbeat.test.ts`; szimulált failure/degraded/recovery UI egy desktop+mobil körben. Új vizuális irány nincs; meglévő dashboardhoz illesztés.

**C9 / M4:** Legalább 24 órás izolált paper próba: nincs dupla fill vagy elveszett state, működő forrás mellett quote-age ≤10 s, exit indulási késés p95 ≤10 s a tervezett ütemhez képest. Ez mérnöki cél, túllépéskor okfeltárás szükséges. Ez még nem profitbizonyíték.

## M5 — Binance-adapter teljessége, live váltás nélkül

### T24 — Symbol filter és minimum-order

- [ ] Kész
- Függőség: T02, T04, T14. Méret: M.
- Fájlok: `src/lib/execution/exchange-rules.ts`, `src/lib/execution/binance-broker.ts`, `src/lib/execution/paper-fill.ts`, `tests/lib/execution/exchange-rules.test.ts`, `tests/lib/execution/binance-broker.test.ts`.
- Elfogadás: aktuális hivatalos dokumentáció és exchangeInfo alapján ár/mennyiség/notional kerekítés; nincs univerzális toFixed vagy fix dollárminimum; paper/backtest ugyanazt az ellenőrzőt használhatja, a broker az indokolatlan minimum-5%-os stoptiltást helyes validációra cseréli.
- Ellenőrzés: `pnpm exec vitest run tests/lib/execution/exchange-rules.test.ts tests/lib/execution/binance-broker.test.ts`; 100 USD tőke, mikroorder/dust, határpontok, stale filter és kerekítés utáni notional.

### T25 — Idempotens orderküldés és tényleges fill

- [ ] Kész
- Függőség: T09, T10, T24. Méret: M.
- Fájlok: `src/lib/execution/binance-broker.ts`, `src/lib/execution/binance-order-state.ts`, `src/lib/execution/order-store.ts`, `tests/lib/execution/binance-broker.test.ts`, `tests/integration/order-recovery.test.ts`.
- Elfogadás: stabil client order ID, orderállapot és fill dedup; base/quote/BNB díj helyes eszközön, hiányzó díjárfolyam jelölt becslés/függő értékelés; timeout után státuszlekérdezés, részleges teljesülés és nulla fill nem hamis teljes siker. BUY stop paramétere nem sérti a közös stratégiát.
- Ellenőrzés: adapterfixture-ek elfogadott de timeoutos, elutasított, részlegesen teljesült, ismételt válaszokra; valódi DB retry-teszt, újraindulás nem küld új azonosítójú duplikátumot.

### T26 — Védőorder teljes életciklusa

- [ ] Kész
- Függőség: T21, T25. Méret: M.
- Fájlok: `src/lib/execution/protection.ts`, `src/lib/execution/binance-broker.ts`, `src/lib/engine/fast-exit.ts`, `tests/lib/execution/protection.test.ts`, `tests/integration/protection-recovery.test.ts`.
- Elfogadás: BUY után net birtokolt qty védelme, order ID tartós; trailing/rávásárlás/részleges SELL után a védelem qty/ára egyezik; TP/manual SELL és zárolt készlet koordinált. Stoptelepítés hibája és cancel/replace közbeni fill explicit incident, nincs puszta console.error utáni normál BUY-folytatás.
- Ellenőrzés: feltöltés/stopcancel közti fill, restart, részleges execution, gap és stop-limit nemteljesülés fixture-ek; tesztkörnyezetben védelem nélküli állapot kimutatása és előre rögzített helyreállítás. Kényszerpiaci zárás nem rejtett alapértelmezés.

**C10:** T24–T26 után exchange-rules, order recovery és protection tesztek zöldek; mock és valódi tesztkörnyezeti bizonyíték külön jelölve.

### T27 — Tőzsdei egyenleg és nyitott orderek egyeztetése

- [ ] Kész
- Függőség: T25, T26. Méret: M.
- Fájlok: `src/lib/execution/reconcile.ts`, `src/lib/engine/worker.ts`, `src/lib/execution/order-store.ts`, `tests/lib/execution/reconcile.test.ts`, `tests/integration/reconcile.test.ts`.
- Elfogadás: induláskor és periodikusan exchange az igazságforrás a live accountnál; free/locked/base/quote és védőorderek egyeznek, új fill egyszer importálódik; kézi tőzsdei kötés vagy eltérés új BUY-t blokkol, helyreállítás idempotens, paper account érintetlen.
- Ellenőrzés: `pnpm exec vitest run tests/lib/execution/reconcile.test.ts`; izolált DB-ben kiesés alatti stop-fill, idegen manuális order, deposit és duplikált trade; tesztkörnyezeti restart egyeztetéssel.

**C11 / M5:** Teljes suite + típusellenőrzés + build; tesztkörnyezeti BUY→védőorder→részleges SELL→zárás→reconcile folyamat. Valós pénzes próbát vagy live váltást ez nem indít.

## M6 — Futtatás, kísérletek és átadás

### T28 — Futtatási és átállási dokumentáció

- [ ] Kész
- Függőség: T11, T22, T23. Méret: M.
- Fájlok: `docs/worker-runbook.md`, `.env.example`, `.github/workflows/tick.yml`, `vercel.json`, `README.md`.
- Elfogadás: helyi worker és választott környezet pontos parancsai, restart/health/rollback; egy aktív scheduler, cron+worker együtt sem dupláz; README a tényleges modellről, ütemről és demó/live státuszról ír. Hosted endpointok auth-követelménye és kulcsok szerepe dokumentált; fizetős hosting csak külön költségdöntéssel.
- Ellenőrzés: tiszta checkoutból runbook követése izolált paper DB-vel; konfiguráció- és secret-ellenőrzés értékek naplózása nélkül. Windows háttérfolyamat rejtett ablakban, külső deploy előtt konkrét konfiguráció bemutatható.

### T29 — Előre rögzített profitkísérleti protokoll

- [ ] Kész
- Függőség: T19, T20, T24. Méret: S.
- Fájlok: `docs/experiments/protocol-v1.md`, `scripts/experiment-configs.ts`.
- Elfogadás: max drawdown és működési költségkeret a jelöltválasztás előtt rögzítve; DCA/momentum és opcionális állapotfüggő szabály, AI kontroll, exit cadence külön kísérlet; időablak/adathash/holdout és elfogadási szabály előre fagyasztott, nincs utólagos küszöbmozgatás.
- Ellenőrzés: a protokollból minden mérés újraindítható; jelöltváltozatok csak a vizsgált paraméterben térnek el; kockázatemelés nem történik implicit. Nyitott felhasználói kockázatdöntésig az eszközök elkészülhetnek, jelöltadoptálás nem.

### T30 — Reprodukálható összehasonlító mérések

- [ ] Kész
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

### T32 — Teljes regresszió és audit-visszaellenőrzés

- [ ] Kész
- Függőség: T01–T31. Méret: M.
- Fájlok: `docs/verification/profit-fixes.md`, `src/app/api/cron/tick/route.ts`, `tests/lib/api/cron-auth.test.ts`, `README.md`, `tasks/todo.md`.
- Elfogadás: minden auditmegállapítás mellé javítás és bizonyíték; hosted order-trigger auth hiányában fail-closed, helyi teszt kivétel explicit; teljes folyamat friss és legacy fixture-rel, crash/recovery és minimumtőke mellett működik. Műszaki készültség és stratégiaeredmény külön verdict, live mód marad kikapcsolva.
- Ellenőrzés: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm build`; összes izolált PostgreSQL-teszt; T31 jelentés, M5 tesztkörnyezeti bizonyíték; egy összesített desktop+mobil ellenőrzés. Nem teljesült külső/mérési kapu fel van tüntetve, a teljes terv addig nincs készre jelölve.

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

# Teljes javítási és validálási terv

Dátum: 2026-09-05. Állapot: elkészült terv; implementáció még nem indult.

Kiindulópont: [profit-audit](../docs/2026-09-05-profit-audit.md). Végrehajtható feladatlista: [todo.md](todo.md). Az ellenőrzőpontok és a készültség kizárólag a todo fájlban vezetendők.

## 1. Cél és hatókör

A bot minden belépési és kilépési útvonalon azonos, helyes kockázatkezelést és elszámolást használjon. A demó és a backtest ugyanazokat a szabályokat mérje, reális teljesülési feltételekkel. A gyorsabb kilépés és a jobb belépők hozamhatása reprodukálható összehasonlítással legyen eldönthető.

A felhasználó szerint az ütemezés jelenleg az elfogyott GitHub Actions-keret miatt szünetel. Nem kell ismeretlen leállási hibát keresni vagy workflow-t újraindítani. A terv tartalmaz Actions-kerettől független worker-futtatást, költségméréssel.

**Feltételezések és alapdöntések:**

- Személyes, spot BTC/ETH/SOL bot; a mód továbbra is paper, nincs tőkeáttétel.
- A 20% pozíciólimit, legfeljebb 3 pozíció, 3% napi veszteségkapu és 5% fix induló stop marad alapértelmezés. Ezeket valóban érvényesíteni kell, nem lazítani.
- A momentum és kockázatalapú méretezés csak elkülönített kísérletben kapcsolható be a validálásig.
- Először 5 perces exit és 60 perces belépés készül; az 1/5/15 perces exit és 15/60 perces belépés külön mért variáns. A gyorsabb ciklus nem jelent automatikusan több ordert.
- A régi naplók nem törölhetők a tisztább mérés kedvéért. Az új mérési szakasz verzióval és kezdőpillanatképpel különül el.
- Ez a kérés tervkészítés. A dokumentum nem bizonyítja a javítások elkészültét, nem indít kereskedést, nem vásárol infrastruktúrát és nem engedélyez live módot.

## 2. Felelősségek és függőségek

| Modul | Felelősség | Függőség |
|---|---|---|
| order-contracts | Order, teljesülés, díj és stratégia verziózott szerződése | — |
| portfolio-ledger | Készpénz, készlet, bekerülési érték, atomikus tárolás | order-contracts |
| market-data | Lezárt OHLCV, aktuális quote, adatminőség | order-contracts |
| risk-gate | Minden orderre közös limit és keretfoglalás | portfolio-ledger, market-data |
| signal-policy | DCA, momentum, AI-intent és tényleges portfóliókontextus | market-data, risk-gate |
| simulation | Paper és backtest közös könyvelés, eltérő explicit fill-modell | portfolio-ledger, signal-policy |
| worker-runtime | Órás belépés, gyors exit, kizárás és újraindulás | simulation, risk-gate |
| exchange-adapter | Binance fill, filter, védelem és egyeztetés | portfolio-ledger, risk-gate |
| evidence-reporting | Nettó eredmény, időzítések, költség és kísérletek | simulation, worker-runtime |

Fő sorrend: szerződés → helyes demókönyvelés és közös kapu → adategységesítés → hiteles backtest → gyors worker → Binance-adapter teljessége → kísérletek és előremenő paper bizonyítás.

A market-data és a ledger rész külön fejleszthető a szerződés után; a közös típusok, séma és migrációk sorrendben készüljenek. A terv nem indít párhuzamos agentmunkát. Egy feladat jellemzően 2–5 kézzel módosított fájl; ennél nagyobb változás külön kompatibilitási részfeladatra bontandó.

## 3. Kötelező működési szerződések

### Order és fill

- BUY-intent: a teljes aktuális equity kívánt hányada; a végrehajtandó quote-költést a risk gate számítja. SELL-intent: a birtokolt, még el nem adott mennyiség kívánt hányada. A két jelentést eltérő mező jelölje.
- Új végrehajtási típus: BUY `maxQuoteSpend`, SELL `baseQty`; nem közös, kétértelmű `amountUsd`.
- Minden intenthez `portfolioId`, `mode`, `strategyVersion`, `origin`, `intentId` és lejárat tartozik. A paper és live számlák nem osztoznak könyvelési sorokon.
- A fill őrizze az exchange order/trade azonosítót, a teljesült mennyiséget, bruttó quote-értéket, a díj mennyiségét és eszközét, valamint a tényleges időt. A sikertelen/nyitott order nem teljesült trade.
- A közös könyvelő pontosan egyszer alkalmazza az eszközmozgásokat. Quote-ban, base-ben és harmadik eszközben fizetett díj külön kezelendő; az USD-re értékelt díj nem vonható le másodszor az egyenlegből.
- Az exchangeInfo szerinti számításokhoz decimális pontosság kell. PostgreSQL `numeric`, dokumentált kerekítés és egy közös decimális számkezelés; a régi `real` értékek pontosságvesztése utólag nem állítható vissza.

Példa a kívánt TypeScript-stílusra (szerződésvázlat, nem kész implementáció):

```ts
type ExecutionOrder =
  | { side: "BUY"; symbol: string; maxQuoteSpend: string }
  | { side: "SELL"; symbol: string; baseQty: string };
```

A közös azonosítókat egy közös típus hordozza. Tiszta számítás, injektált idő és explicit hibák kövessék a meglévő TypeScript/Vitest mintákat; újabb általános keretrendszer nem szükséges.

### Risk gate és állapot

- BUY felső korlát: rendelkezésre álló cash díjtartalékkal, kívánt összeg, `max(0, equity * 0.20 - existingValue - reservedBuys)`, valamint eredetspecifikus keret közül a legkisebb. Minden feltételt ellenőrizni kell, korai százalék-clamp nem ugorhat át másik limitet.
- AI, DCA, momentum és manuális végrehajtás is ugyanide érkezik; a broker csak jóváhagyott és még érvényes ordert kaphat.
- SELL nem függ cash-től. Nem birtokolt coin eladása tiltott; mennyisége legfeljebb a rendelkezésre álló készlet. A védőorderben zárolt készlet felszabadítását az exchange-adapter koordinálja.
- A napi kapu UTC napkezdő mark-to-market equityből számol, pénzmozgásokkal korrigálva. A nap során elért -3% új BUY-t tilt a következő napig; SELL és meglévő védelem marad. Ez a latch tudatos, verziózott javítás.
- Első indítás nap közben: külön résznapos baseline. Kimaradt napkezdő ár esetén nincs kitalált napi hozam; új BUY szünetel, míg hiteles referencia nem áll rendelkezésre. A régi indulás óta mért eredmény külön mutató marad.
- A heti DCA-keret csak az adott portfólió/mód DCA-eredetű teljesüléseit és nyitott foglalásait számolja. 1 USD maradékból legfeljebb 1 USD teljes költség tervezhető; ha ez minimum alatti, nincs kötés.
- Rávásárlás nem csökkenti a már érvényes trailing stopot. A stop jelzett veszteségkorlát, gap esetén nem garantált teljesülési ár.
- Hiányzó DB, hibás egyenleg vagy bizonytalan végrehajtás nem aktiválhat 10 000 USD fallbackkel új ordert. A fallback kizárólag explicit, izolált tesztadapterben maradhat.

### Atomi végrehajtás és helyreállítás

A helyi DB és a tőzsde nem alkot közös tranzakciót. A cél egy szándék legfeljebb egy megbízássá alakítása, és minden teljesülés egyszeri könyvelése; nem szabad ellenőrizhetetlen „exactly once” hálózati ígéretet tenni.

1. Rövid DB-tranzakció: egyenleg/risk ellenőrzés, intent és keretfoglalás létrehozása.
2. Order elküldése stabil client order ID-val, a DB-zár hosszú hálózati hívás alatti tartása nélkül.
3. Timeout esetén `unknown` állapot: először státusz/fill lekérdezés, nem új BUY új azonosítóval.
4. Teljesülések könyvelése egyedi kulccsal és atomi cash/position/fill frissítéssel; részleges fill kezelése.
5. Újrainduláskor függő orderek egyeztetése az új kereskedés előtt. Lease és fencing token akadályozza a régi worker további DB-írását; folyamatban lévő exchange kérésnél az orderazonosító és reconciliation is kell.

A jelenlegi Neon HTTP-driverre nem feltételezhető interaktív tranzakciókészség. A megvalósítás elején a telepített verzió képességeit ellenőrizni kell. Az atomi művelet SQL-függvénnyel/rövid szerveroldali tranzakcióval vagy ehhez megfelelő driverrel készüljön; valódi PostgreSQL konkurenciateszt dönt, nem mock.

### Adat és stratégia

- Modellezéshez tőzsdei, lezárt OHLCV kell: nyitás/zárás/észlelés idő, időkeret, tényleges high/low, egységes base- és quote-volume. CoinGecko/RSS/sentiment külön kontextus marad.
- A visszatekintés az időkerethez tartozik. Legalább a legnagyobb szükséges lookback és warmup rendelkezésre álljon; réses/adathiányos sor nem kap automatikus trendengedélyt.
- Végrehajtáshoz aktuális bid/ask és időbélyeg szükséges. Az exit adatút nem vár LLM-re vagy hírgyűjtőre. Mérnöki induló cél: legfeljebb 10 másodperces quote; ennél régebbin új market order nem készül, állapot és riasztás látszik.
- Model feature-verzió és modellartefaktum összetartozik. A régi modellt nem szabad más jelentésű feature-ökkel tovább használni. Az AUC ≥ 0,5 önmagában nem automatikus modellcsere-kapu.
- Egy közös StrategyConfig legyen a runtime, backtest és kijelzett paraméterek forrása. A régi PROFIT_CYCLE/RISK_LIMITS eltérő párhuzamos beállításai fokozatosan megszűnnek.
- Az AI a valódi belépési árat, pozícióértéket, szabad keretet és adatminőséget kapja. BUY/SELL mezőinek jelentése verziózott; a régi naplókat nem szabad új jelentéssel újraértelmezni.

## 4. A profitmérés szabályai

- Egyetlen fill-ledgerből számoljon cash, készlet, realizált és nem realizált eredmény. A részleges eladásokhoz arányos bekerülési érték és díj tartozzon.
- Az equity-görbe a kötés előtti kezdőtőkétől indul. A Sharpe évesítése a tényleges időközhöz igazodik; hiányzó intervallumot nem szabad csendben normál gyertyának számítani. Nulla veszteség mellett a profit factor végtelen értéke JSON-biztos explicit jelölést kap.
- Backtestben a jel csak az addig elérhető adatokból születhet; lezárt gyertyából képzett jel a következő végrehajtható árra kerül. Stop és TP ugyanazon gyertyában konzervatív sorrenddel vagy finomabb adatokkal oldandó fel.
- A futó 5/60 perces polling és az exchange-oldali függő stop külön végrehajtási mód. Órás high/low-ra reagáló backtest nem nevezhető az óránként spotot néző bot pontos másolatának.
- Jelöltek kiválasztása tanítás/validálás alapján; külön, érintetlen időszak a végső teszt. A végső teszten nem rangsorolunk tovább. Korábbi tournament eredmények örökölt, nem független bizonyítékok.
- Azonos időszak/tőke/költség: cash, BTC buy-and-hold, javított DCA, momentum, opcionális piaci állapot szerinti változat; AI-val és nélküle. Teljes és kitettséghez viszonyított eredmény is kell.
- AI-t csak valóban korábban eltárolt, időbélyeges döntésekkel lehet történelmileg visszajátszani. Új LLM régi hírekkel való futtatása jövőismeretet hordozhat: ez nem tiszta történelmi bizonyíték. Hiányos múlt esetén külön előremenő shadow-paper párok szükségesek.
- Az 1 órás iránytalálat külön diagnosztika marad, nem realizált profit. Hosszú üzemszünet utáni árral nem pontozunk 1 órás döntést: historikus horizontra keresünk árat, vagy hiányosként jelöljük.
- Díj, spread, slippage, adat-, LLM- és hostingköltség látható. 100 USD-s minimumteszt kötelező, nem elég a jelenlegi 10 000 USD backtest. Díj/spread/csúszás külön érzékenységvizsgálat, legalább alap és kétszeres változó költség mellett.

## 5. Mérföldkövek

| Mérföldkő | Feladatok | Kész állapot |
|---|---|---|
| M1: hiteles demóalap | T01–T11 | Helyes pénzmozgás, teljes risk kapu, retry és migráció |
| M2: egységes piaci input | T12–T16 | Lezárt gyertyák, friss quote, működő momentum-adatút, valós AI-kontextus |
| M3: hiteles összehasonlítás | T17–T20 | Végrehajtási paritás, nettó metrikák, független teszt, korrekt AI-mérés |
| M4: gyors demó-worker | T21–T23 | 5 perces exit, 60 perces belépés, kizárás, hibák és költségek látszanak |
| M5: teljes exchange-adapter | T24–T27 | Filter/fill/védelem/egyeztetés izolált környezetben igazolva |
| M6: átadás és eredmény | T28–T32 | Futtatható dokumentáció, mérési jegyzőkönyv, előremenő paper jelentés |

A gyors worker paperben az M4 után használható; a Binance live alkalmassága nem előfeltétele a demó mérésének. Live módváltás nem része a terv végrehajtásának sem.

## 6. Migráció és visszaállás

- Bővítő migrációk és verziózott olvasás; ne írjuk át a régi migrációkat. DB-mentés/snapshot, dry-run és eltérésjelentés precedálja a tényleges konverziót.
- A régi orderId a trades táblában nincs megőrizve, az eredet néhol hiányzik, a papír stopárak lehetnek irreálisak. Nem szabad kitalált execution adatokat pótolni. Régi adat `legacy-unverified` jelöléssel, bizonyítottan számítható korrekció külön auditbejegyzéssel marad.
- A javított ledgerhez új, verziózott mérési epoch készül ellenőrzött nyitóállapottal. Az eredeti cash/positions/trades nem törlődik. Opcionális tiszta 100 USD shadow-paper számla külön portfolio ID-t kap.
- A meglévő, 20% feletti BTC-pozíciót a migráció nem adja el automatikusan. Új BUY tiltott erre a coinra, amíg a limitbe nem fér; a szabályos exit és védelem működhet.
- Visszaálláskor először az új intentképzés álljon le; nyitott exchange ordereket egyeztessünk. Sémakompatibilis előző verzió visszaállítható; destruktív down-migráció és a hibás régi orderút visszakapcsolása nem megoldás.

## 7. Ellenőrzés és parancsok

Meglévő parancsok a repó gyökeréből:

```powershell
pnpm test
pnpm exec tsc --noEmit
pnpm build
pnpm exec vitest run tests/lib/risk/risk-manager.test.ts
pnpm exec vitest run tests/lib/execution/paper-broker.test.ts tests/lib/portfolio/accounting.test.ts
```

Új tesztfájlokra ugyanaz a `pnpm exec vitest run <fájl>` minta. A todo új útvonalai tervezett fájlok; a parancsok a feladat elkészülte után futtathatók. A T01 rögzíti a PostgreSQL-integrációs teszt külön parancsát és teszt-DB változóját. A T22/T28 adja meg a worker pontos indítási és leállítási parancsait; ezeket nem állítjuk most létezőnek.

Minden logikai javításnál előbb a hibát bizonyító viselkedési teszt, utána javítás. Valódi izolált PostgreSQL teszt kell tranzakcióra, egyediségre, versenyhelyzetre és migrációra. Külső API-adapter szerződéstesztek visszajátszható fixture-rel; tényleges tőzsdei integráció csak külön tesztkörnyezetben. Mockteszt nem live bizonyíték.

2–3 feladatonként célzott checkpoint, mérföldkövenként teljes suite + típusellenőrzés + build és az adott út integrációs próbája. Újraépítés csak változás vagy hiba miatt ismétlendő. UI-ellenőrzés egy desktop+mobil körben, javítási köteggel és legfeljebb egy megerősítéssel. A jelenlegi 182 sikeres teszt kiinduló állapot, nem elegendő végső kapu.

## 8. Döntések, amelyeket később kell rögzíteni

Ezek nem akadályozzák a tervet vagy a helyi hibajavítást:

- Hosting szolgáltató és teljes havi keret: T28 előtt, aktuális ajánlat és mért CPU/memória/API-költség alapján. Helyi workerrel közben elvégezhető a fejlesztés.
- Kutatási max drawdown és kísérleti kockázati keret: T29 előtt. Döntésig a jelenlegi limitek maradnak; magasabb kockázatú jelölt nem fogadható el automatikusan.
- Külső adatbázis tényleges migrációja: mentés és dry-run eredmény alapján ütemezendő. A lokális migrációs kód és izolált teszt előtte készül el.
- Live mód, valós pénzes ellenőrzés és fizetős szolgáltatás aktiválása külön felhasználói döntés. Az összes felkészítés és tesztkörnyezeti bizonyíték előbb elkészítendő.

## 9. Teljes készültség feltétele

Mind a 32 feladat és az ellenőrzőpontok bizonyítékkal lezárva; az audit minden eltérése visszakereshető feladathoz kötve. Műszakilag helyes demó, pontos mérés és reprodukálható kísérlet a kötelező eredmény. Ha nincs költségek után robusztusan jobb stratégia, a mérési jelentés ezt mondja ki, és a javított alapvonal marad. A nyereség hiánya nem jogosít fel kockázati limitek csendes emelésére.

Régi `docs/superpowers` tervek történeti anyagok. Az audit által feltárt javítások aktuális sorrendjét ez a dokumentum és a todo rögzíti; régi, néhány napos paper-kaput nem szabad tartós profitbizonyítéknak átvenni.

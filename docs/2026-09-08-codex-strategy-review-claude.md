# Claude-nak átadható brief — részvény és kripto stratégiaaudit

Dátum: 2026-09-08. Vizsgált checkout: `7abef22`. Ez kód- és mérésmódszertani audit, nem új stratégia bevezetése.

## Döntés

**A rendszert nem tekintem hibamentesnek. Sem a részvényes, sem a kriptós stratégia tartós nyereségessége vagy optimalitása nincs bizonyítva. Előbb a végrehajtás és a mérések hibáit kell javítani, utána érdemes stratégiát választani.**

Van használható alap: közös decimális ledger, közös orderenkénti kockázati kapu, elkülönített USD/USDT számlák, lejáró intentek, lezárt gyertyák, ML-karantén és sok teszt. A részvényes momentum + napszakszűrő értelmes vizsgálandó hipotézis. Ezek azonban nem helyettesítik a következő hibák javítását.

**Most ellenőrizve:** `pnpm test`: 91 fájl, 980/980 teszt sikeres; `pnpm exec tsc --noEmit`: sikeres. A lentiek forráskód alapján azonosított hibák; új célzott reprodukciós tesztek ebben az auditban nem futottak. Nem futtattam új stratégiai versenyt, production buildet, PostgreSQL-integrációt vagy éles brókerellenőrzést. A korábbi hozamszámokat a repó jelentéseiből idézem. Kereskedési kódot, env-et, adatbázist és ütemezést nem módosítottam.

## Elsőként javítandó hibák

### 1. P1 — A részvényes napi veszteségkapu ki van kerülve

Hely: `src/lib/engine/stock-tick.ts:469–470`.

A `runStockCycle` minden orderhez `dailyLossLatched: false` és `dayBaselineMissing: false` értéket ad. A konfiguráció 3%-os napi korlátja így ebben az ágban nem működik. A forráskomment és a README ennél erősebb védelmet ígér.

**Javítás:** stock-paper hatókörű, tartós napi equity-referencia és veszteséglatch; a választott napdefiníció legyen explicit. Hiányzó értékelés/baseline tiltsa az új BUY-t, a pozíciócsökkentő SELL maradjon engedélyezett. A kockázati állapotot a tényleges végrehajtás előtt is ellenőrizni kell.

**Elfogadás:** napi limit átlépése után sem momentum, sem más belépő nem jut a brokerhez; újraindítás megőrzi a tiltást; napváltás és pénzmozgás helyesen működik; stop és nap végi zárás továbbra is megy.

### 2. P1 — A részvényes kötési ár múltbeli gyertyazáró, nincs végrehajtási frissességkapu

Hely: `src/lib/engine/stock-tick.ts:423–429`, `src/lib/markets/yahoo.ts`, `scripts/stock-intraday-backtest.ts:203–231`.

A jel és a végrehajtás ugyanabból az utolsó lezárt gyertyából dolgozik. A broker a gyertya `close` értékét kapja `last` árként. A gyertya lezártsága nem bizonyítja, hogy az ár MOST is kereskedhető. Régi, de belsőleg folytonos sorozatot sem utasít el életkor alapján. Nyitáskor ez előző napi ár is lehet.

A backteszt ugyanennek a jelgyertyának a záróján teljesít; a jel elkészülésének és a következő elérhető kötési árnak nincs külön időpontja. A történeti záróárhoz hozzáadott fix slippage ezt önmagában nem oldja meg. A dokumentált Yahoo `regularMarketTime` késleltetésmérést a végrehajtó kód nem használja kapuként.

**Javítás:** külön `signalAsOf`, `observedAt`, `decisionAt`, `executionAt`; futáskor időbélyeges bid/ask vagy explicit minőségű végrehajtási ár és session-aware adatéletkor. Backtesztben a lezárt jel után következő végrehajtható esemény/ár és késleltetés. A stop/TP történeti high/low megfigyelését és a polling végrehajtást is külön kell modellezni.

**Elfogadás:** azonos lezárt jel mellett a későbbi quote változása módosítja a fillt; elavult ár nem eredményez sikeres kötést; a következő bar jövőbeli adatai nem befolyásolják a nyitón végrehajtott ordert. Ezután újra kell mérni a részvényes rangsort.

### 3. P1 — A nap végi teljes zárás nem garantált; API-hiba tört készletet hagyhat bent

Hely: `src/lib/markets/alpaca.ts:153–155`, `src/lib/markets/execution.ts:43–44`, `src/lib/engine/stock-tick.ts:442,583–587`, `src/lib/engine/run-scheduled-stock-intraday.ts:157,168,238`.

Az `allFractionable` egyetlen eszköz metaadathibájára is false lesz. Ekkor a teljes ciklus, az eladásokkal együtt, egész részvényre vált. Példa: korábban vásárolt 1,5 részvényből a flatten csak 1 darabot tud eladni; 0,5 bent marad. Egy 0,5 darabos pozíció eleve nem zárható ezen a szűrőn. A sikertelen metaadat-lekérés null eredménye is cache-be kerülhet.

Külön probléma: ha egy birtokolt papírra nincs gyertya, a zárás egyszerűen `continue`; ha más papírra volt adat, a ciklus ettől még `ok: true` lehet. A zárási időablak kimaradása után sincs explicit maradványpozíció-helyreállítási állapot. Ezért a dokumentáció „nulla overnight kockázat” állítása túl erős.

**Javítás:** a birtokolt mennyiség zárhatóságát válaszd el az új belépések metaadatkapujától; instrumentumonkénti szabályok, utolsó hiteles metaadat és dokumentált hibaág. Flatten után ellenőrizd a tényleges maradékot; hiányzó adat/pozíciómaradvány legyen tartós incidens és ne sikerjelzés. Legyen következő végrehajtható időpontra helyreállítási terv. Adathiányt ne oldj fel kitalált fillárral.

**Elfogadás:** 1,5 és 0,5 darabos pozíció, Alpaca 500, részleges Yahoo-hiba és elmaradt utolsó cronhívás tesztje. A rendszer vagy igazoltan lapos, vagy egyértelműen jelzi a nyitva maradt kitettséget.

### 4. P1 — Jövőbeli ár kerül a kriptobackteszt nyitáskori kockázati számításába

Hely: `src/lib/backtest/engine.ts:106–121,274–291`.

A függő order a mostani bar **nyitóján** teljesül, de előtte a `riskContext(frame)` a mostani bar **zárójával** értékeli a készletet. A DCA heti kerete is ebből az equityből számolódik. A később kialakuló záróár így megváltoztathatja a nyitáskori headroomot, keretet és vételméretet. A jel időzítése önmagában tehát nem teszi look-ahead-mentessé a backtesztet.

**Javítás:** nyitáskori orderértékelés csak akkor ismert árakkal; külön nyitási és zárási árkép. A zárási értékelés maradjon a bar lezárása utáni lépésben.

**Elfogadás:** két történet azonos múlttal és azonos következő nyitóval, eltérő következő záróval ugyanazt a nyitáskori kötést/keretet adja. Legyen a tesztben meglévő készlet és közel teljes pozíciókeret, hogy valóban érzékeny legyen a hibára.

### 5. P1 — Az L2/L3 forward-paper nem a meghirdetett heti keretet méri

Hely: `src/lib/strategy/weekly-budget.ts:126–132`, `src/lib/engine/tick.ts:530`, `src/lib/backtest/shadow-lanes.ts:48,65`.

Az L2/L3 konfiguráció 20%-os heti DCA-keretet kér. A `remainingWeeklyBudget` viszont mindig a globális `PROFIT_CYCLE.dcaWeeklyBudgetPct` 5%-át használja, a `runTick` nem adja át a sáv saját értékét. 320 USD equityn ez 16 USD heti keret a szándékolt 64 helyett, még költés és foglalás előtt.

**Javítás:** a ténylegesen futó stratégia paraméterét add át a keretszámításnak, és rögzítsd a hatásos konfigurációt a mérési naplóban. A korábbi L2/L3 adatot címkézd hibás konfigurációjú mérésként; ne kezeld utólag úgy, mintha 20%-kal futott volna.

**Elfogadás:** ugyanazon equity mellett baseline 5%, L2/L3 20%; elkülönített számlák költése és foglalása ne keveredjen.

### 6. P1 — További kripto backteszt–futó rendszer eltérések

Hely: `src/lib/backtest/engine.ts:121,192,274,334`; összevetés: `src/lib/strategy/weekly-budget.ts` és `src/lib/engine/tick.ts`.

- A backtesztben a napi veszteséglatch mindig false: a futó kriptó napi kapuját nem modellezi.
- A backteszt `buyLog` minden BUY-t beleszámol a DCA heti költésébe, beleértve a momentumot is; a futó rendszer csak a DCA-eredetűeket. A backteszt díjjal együtt, az élő helper bruttó fillértékkel számolja ezt a költést.

**Javítás:** közös napi kapulogika és explicit, azonos heti költésdefiníció. A momentum és DCA költése eredet szerint váljon szét. A történeti összehasonlító jelentéseket ezek és a 4. pont javítása után regeneráld.

**Elfogadás:** momentumvétel ne fogyassza a DCA-keretet; limitátlépés és napváltás a backtesztben is ugyanazt a tiltást eredményezze. Az eltéréseket tényleges viselkedési teszttel ellenőrizd, ne csak azonos konfigurációs konstansokkal.

### 7. P1 — A kripto út figyelmen kívül hagyhatja az elutasított tartós könyvelést

Hely: `src/lib/engine/tick.ts:451`, `src/lib/engine/execute-intent.ts:188–190`, `src/lib/execution/order-store.ts:persistFill`, `src/db/migrations/0005_fenced_money_writes.sql`.

Az SQL lejárt/érvénytelen lease esetén `{applied:false, reason:'fenced'}` eredményt adhat kivétel helyett. A `persistFill` ezt visszaadja, a kripto tick azonban nem vizsgálja az eredményt. Az `executeIntent` utána a memóriabeli ledgert továbbvezeti és a kötést végrehajtottnak jelentheti, miközben a DB nem könyvelte. Ez forrásból következő hibaút; konkrét production előfordulását nem ellenőriztem.

**Javítás:** a tartós könyvelés eredménye legyen része az execution szerződésnek. Fencing-elutasítás állítsa meg a ciklust és indítson hiteles állapot-visszatöltést/egyeztetést. A duplikátum külön idempotens ág legyen, amely nem alkalmaz még egy deltamozgást a már friss állapotra. A régi dashboard-vetület se kapjon nem commitolt kötést.

**Elfogadás:** `fenced`, `duplicate_fill` és valódi DB-hiba tesztje; egyik sem állíthat elő hamis új sikert vagy továbbköltést. Valódi PostgreSQL-integrációban is ellenőrizendő.

## Mit mondhatunk a stratégiákról?

**Részvény:** a repó szerint a breakout +1,08%, a `tod60+regime` +1,56% eredményt adott a vizsgált körülbelül 60 kereskedési napos mintán. Ezek jelöltek, nem igazolt várható hozamok. A leírt 2026-06-11 → 2026-09-04 időtartam nem 60 naptári nap; a minta hosszát és tényleges ülésszámát a cache-ből kell egyértelműen riportolni. A 22 alak, a további paraméterrácsok és ugyanazon minta két felének ismételt vizsgálata nem érintetlen out-of-sample teszt. A két pozitív fél nem elegendő a „robusztus”, a placebo-kontraszt nem elegendő a „bizonyított valódi jel” állításhoz. A többszörös keresés miatt túlillesztés lehetséges. [Kutatási alap: The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

**Kripto:** a javítások utáni dokumentált összevetés maga is `UNDECIDED`, a kiválasztott jelölt holdoutján 3 lezárt kötéssel. A korábbi Sharpe-számok nem bizonyítják a mostani implementáció előnyét. Az AI hozzáadott nettó értéke nincs bemutatva; a szabályalapú backteszt nem méri a futó LLM-es rendszert. A trend-szűrő a kódalapú DCA-ágban van, az AI-vételre nem közös belépési feltételként érvényesül: ezt dokumentáld külön stratégiai ágnak, vagy explicit döntés alapján egységesítsd. Ne állítsd a teljes rendszerre, hogy minden belépő trend-szűrt.

A kriptós `results-v1.md` szövege ráadásul azt mondja, hogy a készpénzt egyik variáns sem verte, miközben ugyanott pozitív variánseredmények is szerepelnek. Pontosítsd: melyik költségszinten, melyik mintán, melyik elfogadási feltételt nem teljesítették. A „nem adoptálható” és a „nem volt pozitív” külön állítás.

## Következő mérés és munkasorrend

1. Először 1., 3. és 7. pont: kockázati kapu, zárhatóság, hiteles könyvelés. Utána 2., 4–6.: korrekt időzítés és mérési paritás. Minden hibához célzott regressziós teszt.
2. Fagyaszd a konfigurációt és az adatot: commit, adat-hash, pontos dátumok/ülések, univerzum, belépőnév, fractional mód, költségmodell, AI/prompt/modellverzió. A stock strategyVersion jelenleg a választott env-es entryShape-t nem különbözteti meg: legyen konfiguráció-hash is a kötés/mérés mellett.
3. A javított részvényes alapvonal és legfeljebb néhány előre kiválasztott jelölt kapjon új, érintetlen tesztidőszakot. A már végigoptimalizált minta fejlesztési adat. Tesztelj eltérő piaci rezsimeket és költség/késleltetés stresszt; ne válts automatikusan a régi táblázat nyertesére.
4. Kontrollok: készpénz, SPY/részvénykosár buy-and-hold, kriptón BTC és kosár buy-and-hold, egyszerű szabályalapú baseline. Teljes tőkére vetített hozam mellett azonos kockázatú vagy kitettségű összevetés is kell. A kisebb drawdown önmagában lehet a sok készpénz következménye.
5. Riport: nettó portfólióhozam, max drawdown, napi eredmények, tényleges tőkekitettség, lezárt pozíciók, részzárások, spread/slippage/díj, AI és infrastruktúra költsége külön is. A részvényes backteszt drawdownja jelenleg a ciklus előtti `equityNow`-t mintázza; a kötések utáni és végső equity is kerüljön bele. A félminták barindex szerinti vágása helyett session-határon vágj, és ellenőrizd a záró készletet/kilépési költséget.
6. AI-ág: elkülönített forward-paper AI-val és AI nélkül, azonos piaci megfigyelésekkel, saját helyes portfóliókontextussal. A csak szabályos múltbeli backtesztből ne következtesd, hogy az LLM profitot hoz. A papíros fillmodell korlátait őrizd meg a riportban; a paper működés nem élő teljesülési bizonyíték. [Alpaca hivatalos paper trading leírás](https://docs.alpaca.markets/us/v1.4.2/docs/paper-trading).

**Kért kimenet Claude-tól:** hibánként javítás és reprodukciós teszt, futtatott ellenőrzések pontos eredménye, a régi mérések érvényességi címkéje, majd új, reprodukálható összehasonlítás. Ne állítsd, hogy megtaláltad a „legprofitábilisabb” stratégiát. A megválaszolható kérdés: a javított jelöltek közül melyik mutat költségek után, előre rögzített kockázati feltételekkel, új adaton is fennmaradó előnyt — vagy nincs ilyen jelölt.

## Kiegészítés — mit vegyünk át a Kon szelektív kereskedési tervéből?

**Döntés, 2026-09-08:** vegyük át a költségtudatos, szelektív működést, a döntések visszakövethetőségét és az őszinte státuszkijelzést. A pontszámos belépést és a több idősík megerősítését külön mérhető stratégiai jelöltként vezessük be. A teljes angol Kon-leírás termékigényeit ne kezeljük bizonyított stratégiaként vagy automatikusan végrehajtandó teljes redesignként. Ez a fejezet megvalósítási utasítás; az alábbi funkciók elkészültségét nem állítja.

### Átvételi döntések

| Eredeti pont | Döntés | Megvalósítási határ |
|---|---|---|
| 1. Szelektív belépés, költség, limitek | Átvenni, fokozatosan | Közös belépési ellenőrzés, elkülönített kemény korlátok és kísérleti pontszám; lásd K2–K3. |
| 2. Több idősík | Kísérleti jelölt | Először részvényen 15 perces jel és 1 órás trend; külön összevetés a meglévő stratégiával. |
| 3. Döntési indoklás | Átvenni | Tényleges feltételeredményekből képzett, tartós döntési rekord. |
| 4. Kötésjelölők | Átvenni | A hiteles fill- és pozíciótörténetből, részteljesülésekkel és részzárásokkal. |
| 5. Chartkezelés és idősíkok | Átvenni lépcsőzetesen | Előbb helyes aggregáció és stabil navigáció; csak igazolt adatlefedettségű idősíkok. |
| 6–7. Főoldali automatika és portfólió | Átvenni | Valós működés, számlánként helyes adatok és egyértelmű vezérlés. |
| 8. Teljes UI-redesign | Későbbre tenni | Most a fenti konkrét funkciók illeszkedjenek a meglévő felülethez; új navigáció és kötelező sötét téma nem szükséges. |
| 9. Státusz minden releváns képernyőn | Átvenni | Egy közös szerveroldali állapotból, frissességgel és hibaállapottal. |
| 10. Őszinte teljesítmény | Kötelező alapelv | Nulla kötés és negatív eredmény is érvényes; a történeti adatok nem írhatók át kedvezőbbnek. |
| 11. „Miért nem kötött?” | Első funkcionális prioritás | Piaci elutasítás, kockázati tiltás, adathiány és futási hiba külön megjelenítve. |
| 12. Bizonytalanság kommunikációja | Kötelező alapelv | A score nem valószínűség; becslést csak az alapjául szolgáló mérés megjelölésével mutass. |

### K0 — Javított alapvonal a stratégiai kísérlet előtt

- [ ] Az audit 1–7. hibáját a fenti sorrendben javítsd és célzottan ellenőrizd. A napló és a felület előkészítése közben haladhat, de új stratégia előnyéről csak a javított rendszerben szülessen döntés.
- [ ] A javított baseline kapjon rögzített konfigurációt, adatverziót, költségmodellt és új mérési eredményt. A régi, hibás mérés ne legyen az új jelölt ellenfele.
- [ ] A részvényes és kriptós számlák, limitek, kereskedési napok és eredmények maradjanak elkülönítve. A részvényes beállítások ne kerüljenek automatikusan a kriptós DCA-ra.

**Elfogadás:** a veszteségkapu, a tényleges zárhatóság, a tartós könyvelés és a jel utáni végrehajtás bizonyítékai szerepeljenek a jelentésben; a backteszt és a paper futás ugyanazt a releváns szabályt alkalmazza.

### K1 — Hiteles döntési napló és „Miért nem kötött?”

**Elsőként ezt építsd meg.** Minden elemzési ciklus és értékelt jelölt kapjon azonosítót. A döntési rekord tartalmazza a számla/piac/stratégia azonosítóját, a konfiguráció hashét, az adat és a döntés időpontját, a felhasznált idősíkokat, a feltételek mért értékét és küszöbét, az elutasítási kódokat, valamint az intent/fill kapcsolatot, ha létrejött.

- [ ] Válaszd külön az elemzési eredményt (`ENTER_CANDIDATE`, `SKIP`, `BLOCKED`, `DATA_UNAVAILABLE`) a végrehajtás eredményétől. Egy megfelelő jelölt még nem sikeres kötés.
- [ ] A magyarázat a ténylegesen kiértékelt feltételekből épüljön. Az LLM opcionálisan rövidítheti a szöveget, de nem találhat ki indokot, adatot vagy valószínűséget.
- [ ] A ciklusösszesítés mutassa a tervezett univerzumot, az érvényes adattal elemzett papírokat, az adathiányosakat, a megfelelő és elutasított jelölteket. A kategóriák legyenek egyeztethetők; több elutasítási okhoz legyen egy determinisztikus fő ok.
- [ ] Mutasd a legjobb értékelhető jelöltet és a hiányzó feltételt. Score bevezetése előtt feltételteljesülést mutass; adathiánynál ne gyárts „legjobb jelöltet”.
- [ ] A „nem volt megfelelő jel” mellett külön jelenjen meg a „nem futott le az elemzés”, „elavult adat”, „napi limit”, „piac zárva” és „végrehajtási hiba”.

**Elfogadás:** legyen ellenőrzött példa minden fő állapotra; azonos bemenetből ugyanazok az okkódok keletkezzenek; újratöltés után is visszakereshető legyen a kihagyott jelölt. Egy sikertelen vagy kimaradt futás ne jelenjen meg sikeres piacfigyelésként.

### K2 — Közös belépési korlátok és költségszűrés

**Függőség: K0; naplózása K1-be történjen.** A meglévő közös orderkockázati kaput bővítsd vagy ahhoz csatlakozz; ne hozz létre megkerülhető UI-szűrést. Minden új automatizált BUY, az AI-ból érkező is, menjen át a közös biztonsági korlátokon. A stratégiai feltételek alkalmazási körét eredet szerint explicit konfiguráld.

- [ ] Konfigurálható legyen a napi új belépések maximuma, a belépések közötti minimumidő, a szimbólum zárása utáni cooldown és az opcionális veszteség utáni cooldown. A pozíciószám- és napi veszteségkorlátot a meglévő megoldással egységesítsd.
- [ ] A napi belépési keret számlaszintű legyen, az időköz/cooldown számla és szimbólum szerint. Részvényen a tőzsdei session napja, kriptón UTC nap legyen az explicit napdefiníció. Ne másold át a prompt példaszámait: a küszöböket a javított baseline és az adott stratégia időtávja alapján, a teszt előtt rögzítsd.
- [ ] A napi belépésszámláló egy logikai BUY order első teljesülését számolja, a rávételt is; további részfill ne számítson új belépésnek. A függő BUY foglaljon helyet és keretet, hogy párhuzamos futások se léphessék túl a limitet. Elutasítás/törlés oldja fel a foglalást, újraindítás őrizze meg a helyes állapotot.
- [ ] Belépés előtt ellenőrizd a spreadet, likviditást, adatfrissességet, a stophoz igazított méretet és a várható oda-vissza végrehajtási költséget. A méretet a stop távolsága mellett továbbra is korlátozza a készpénz és az összesített kitettség; a stopár nem garantált teljesülési ár.
- [ ] Külön kezeld a tervezett célár/stop arányát és a statisztikai várható értéket. A célárig elérhető profit mínusz költség neve „nettó célárpotenciál” legyen; ez önmagában nem pozitív várható érték.
- [ ] Ha létezik validált becslés, a nettó várható érték alapja: `p × átlagos bruttó nyereség − (1−p) × átlagos bruttó veszteség − várható teljes kötési költség`. Az átlagok tartalmazzák a tényleges kilépési szabály hatását; ne feltételezd, hogy minden nyertes céláron, minden vesztes pontosan stopáron zár. Nettó hozamadatokból számolva ne vond le újra a költséget.
- [ ] Validált becslés nélkül az EV és a nyerési esély legyen hiányzó, magyarázattal. Az EV-kaput igénylő jelölt ilyenkor ne kössön; a külön definiált szabályalapú baseline működhet a saját feltételeivel, de ne állítsa magáról, hogy bizonyítottan pozitív EV-jű.
- [ ] A belépési score, cooldown és darablimit kizárólag új kockázat felvételét korlátozza. Stopot, kockázatcsökkentő eladást és nap végi zárást nem blokkolhat.

**Elfogadás:** határértékek, költség miatt elutasított jel, hiányzó becslés, részfill, párhuzamos intent, újraindítás és napváltás tesztelve; aktív belépési tiltás mellett a védelmi kilépés továbbra is működik. Ugyanezek a szemantikák jelenjenek meg a backtesztben is.

### K3 — Pontszám és több idősík: külön mérendő jelöltek

**Függőség: K0–K2.** Első alkalmazási kör a részvényes intraday ág. A kriptóra külön kísérlet és külön küszöbök szükségesek.

- [ ] Először a meglévő jelből készíts determinisztikus, verziózott, 0–100 közötti minőségi pontszámot. Kevés, visszakövethető összetevő legyen: trendhez illeszkedés, belépőjel erőssége, volumen/likviditás és volatilitáshoz viszonyított belépési helyzet. Rögzítsd a normalizálást és a súlyokat; ne számítsd ugyanazt a trendet több korreláló indikátorral többször teljes értékű bizonyítéknak.
- [ ] A kemény kockázati/adat/költségkorlátokat semmilyen magas score nem írhatja felül. A `minimumTradeScore` kezdetben csak megfigyelési módban fusson, és az elutasított jelöltek is kerüljenek naplóba.
- [ ] Első többidősíkos jelölt: a részvényes 15 perces belépőjel mellé az utolsó teljesen lezárt 1 órás gyertya trendje. Az 5 perces belépőfinomítást, a 4 órás és napi együttes megerősítést most halaszd el; a baseline eltérő idősíkját is őrizd meg az összevetéshez.
- [ ] A magasabb idősík kizárólag a döntéskor már ismert, lezárt adatból épüljön. Részvényen session-határokhoz és tőzsdei időzónához igazítsd az aggregációt, kezeld a nyári időszámítást és a rövid kereskedési napot. Hiányos history esetén a jelölt legyen nem értékelhető.
- [ ] A score ne kapjon százalékjelet vagy „nyerési esély” címkét. Becsült valószínűséget csak későbbi kalibráció után vezess be, előre definiált kimenetre: az adott kilépési szabállyal, költségek után pozitív lezárt ügylet. Mutasd a mintaszámot, mérési időszakot és bizonytalanságot is.

**Elfogadás:** azonos adatok és konfiguráció ugyanazt a score-t adják; későbbi vagy még nyitott gyertya módosítása nem változtatja meg a korábbi döntést. Új stratégiai feltétel csak K4 döntése alapján kerüljön az alapértelmezett paper stratégiába.

### K4 — Bizonyítsuk, hogy a szűrés hozzáad valamit

- [ ] Előre rögzített, kicsi összehasonlítás készüljön: javított baseline; baseline + költség/gyakorisági szűrő; ez + score-küszöb; ez + 1 órás megerősítés. A közös biztonsági javítások minden ágban legyenek jelen. A score és a több idősík hozzáadott hatását külön is lehessen látni.
- [ ] Az adatot időrendben válaszd szét fejlesztésre és érintetlen értékelésre; átnyúló ügyletek/kimeneti ablakok ne szivárogjanak a részek között. A végső értékelésen már ne hangolj küszöböt. Utána külön számlákon, azonos megfigyelések mellett előre futó paper összevetés következzen.
- [ ] Riportold a teljes tőkére vetített nettó hozamot, maximális visszaesést, kitettséget, fordulatszámot, lezárt ügyletek számát, teljes költséget és a becslések bizonytalanságát. Stresszeld a spreadet, csúszást és késleltetést. A kevés kötés önmagában ne legyen sikerfeltétel.
- [ ] Az elfogadási küszöböket és a minimálisan szükséges bizonyítékot még a futtatás előtt írd le. Ha kevés a lezárt ügylet, nincs egyértelmű javulás vagy csak egy szűk piaci szakasz kedvező, az eredmény `UNDECIDED` vagy `REJECTED`; ne lazíts utólag a feltételeken, hogy legyen nyertes.

**Elfogadás:** reprodukálható jelentés konfigurációval, adathivatkozással, bizonytalansággal és `ADOPT / REJECT / UNDECIDED` döntéssel. Az `ADOPT` ebben a körben kizárólag az alapértelmezett paper változat kiválasztása, nem live kereskedés engedélyezése.

### K5 — Kötéstörténet és használható chart

**Függőség: hiteles könyvelés K0-ból és döntési kapcsolat K1-ből.**

- [ ] A chartjelölők tartós fillazonosítóra épüljenek; intentből ne rajzolj teljesült vételt. Az entry–exit kapcsolat kezelje a rávételt, részfillt és több részzárást. A tényleges kilépési ok döntse el a stop/TP/kézi/egyéb automatikus jelölést, ne az eredmény előjele.
- [ ] Idősíkváltáskor a tényleges teljesülési időt rendeld az új gyertya intervallumához; a pontos idő és ár a kártyán maradjon meg. A nézeten kívüli kötés továbbra is szerepeljen a történetben. Azonos gyertyára eső jelölők legyenek felbonthatók.
- [ ] A kártya mutassa az árakat, mennyiséget, belépési/kilépési időt és indokot, stopot/célárat, stratégiaverziót, az akkor rögzített score-t és a bruttó/nettó eredményt. A slippage/spread beépülhet a fillárba: a költségbontás egyezzen a ledgerrel, ne vonja le kétszer. Ismeretlen történeti adatot ne pótolj kitalált értékkel.
- [ ] Előbb a használt 15 perces, 1 órás és napi adatok helyességét bizonyítsd. A többi kért idősík csak elegendő valódi history mellett jelenjen meg; az idősíkváltás valódi OHLCV-aggregációt és indikátor-újraszámolást végezzen. Órás adatból nem készíthető valódi 1 perces chart.
- [ ] A meglévő chartkönyvtárral oldd meg a kurzor körüli zoomot, húzást, crosshairt, tooltipet, resetet és az automatikus illesztést. Adatfrissítés ne rántsa el a kézzel beállított nézetet; érintéses zoomot a támogatott környezetben ellenőrizz.

**Elfogadás:** ismert filltörténetből azonos összesített nettó P&L adódik a chartkártyán és a ledgerben; idősíkváltás/újratöltés után a kötések visszakereshetők. Desktop és mobil ellenőrzés egy kötegben, egy javítási köteg, legfeljebb egy megerősítő kör.

### K6 — Főoldali automatika és egyértelmű állapot

**Függőség: K0–K1.** A felület meglévő stílusát kövesd; külön designfeladatnál a projekt Impeccable-folyamatát használd.

- [ ] A főoldali widget tartalmazza a kiválasztott számla equityjét, szabad pénzét, napi/teljes nettó eredményét, pozíciószámát, mai belépéseit és korlátját, napi veszteséghatárát, utolsó sikeres elemzését, következő tervezett futását és a várakozás okát. Hiányzó napkezdő referencia esetén a napi P&L legyen nem elérhető, ne nulla.
- [ ] A „Current risk 38%” helyett definiált mutatót használj: például tőkekitettség; külön opcionálisan stopig becsült veszteség. A két szám ne kapjon közös, bizonytalan „kockázat” címkét. A napi veszteség a napkezdő értékhez, a napi drawdown a napon belüli equity-csúcshoz viszonyuljon.
- [ ] A RUNNING/PAUSED/STOPPED a kívánt vezérlési állapotot mutassa, mellette külön legyen a tényleges futási egészség és frissesség. Bekapcsolt ütemezés kimaradt futással ne látszódjon egészséges automatizálásnak. Minden releváns oldal ugyanazt az állapotforrást használja.
- [ ] START engedélyezze az új belépések kiértékelését a korlátokkal. PAUSE szüneteltesse az új belépéseket, de tartsa aktívan a pozícióvédelmet. STOP állítsa le a belépési automatát és vonja vissza a még visszavonható belépési intenteket; meglévő pozíció mellett a védelmi kilépések maradjanak aktívak, ezt a felirat tegye világossá. A „Minden pozíció zárása” külön művelet legyen, ellenőrzött maradékpozícióval.
- [ ] A részletes konfiguráció külön oldalra kerüljön. A főképernyőre ne másold ki az összes indikátort és kísérleti paramétert. A legjobb jelölt mellé csak létező pontszámot/kalibrált becslést írj.

**Elfogadás:** reload és több megnyitott oldal mellett egyező státusz; tesztelt kimaradt futás, adatprobléma és szüneteltetés. A PAUSE/STOP ne hagyjon védelem nélkül már nyitott pozíciót, és ne jelezzen sikeres teljes zárást maradvány mellett.

### Claude munkasorrendje és elvárt átadás

1. K0 biztonsági és mérési javítások, majd rögzített baseline. K1 naplózás közben előkészíthető.
2. K1 döntési átláthatóság és K2 közös belépési korlátok.
3. K3 megfigyelési mód és K4 előre rögzített összevetés. Bizonyíték nélkül ne állítsd át az alapértelmezett stratégiát a pontozott változatra.
4. K6 főoldali állapot és K5 chart; ezek a stratégiai mérés ideje alatt is elkészíthetők a már hiteles adatmodellre.
5. Az átadásban feladatonként jelöld: elkészült, tesztelt, csak előkészített vagy mérésre vár. Add meg a ténylegesen futtatott ellenőrzéseket, a nyitott korlátokat és a stratégiai döntést. A már meglévő funkciókat egészítsd ki, ne építs második kockázati motort vagy párhuzamos könyvelést.

**Most nem része a döntésnek:** teljes termékátnevezés vagy redesign, új chartkönyvtár, minden idősík egyidejű kötelező megerősítése, bizonyíték nélküli százalékos nyerési esély, live módra váltás. A fejlesztés célja az ellenőrizhető döntésminőség és a mérhető nettó előny; a „kevesebb kötés” önmagában nem nyereségbizonyíték.

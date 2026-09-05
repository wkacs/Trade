# Profit és reakcióidő — projektvizsgálat, 2026-09-05

## Következtetés

A legjobb következő lépés a mérés és a tőkekezelés javítása, majd a gyors kilépés és a jobb belépési stratégia külön tesztelése. A jelenlegi kód és adatok nem bizonyítanak maximalizált vagy tartósan pozitív nettó hozamot. A gyakoribb futás reakcióidőt javíthat; hozamnövekedése mérendő hipotézis.

A felhasználó megerősítette: a szünet oka az elfogyott GitHub Actions-keret, a rendszer demó. Ezt nem tekintjük ismeretlen üzemhibának. A vizsgálat nem indított kereskedést, nem módosított beállítást, adatbázist vagy végrehajtási kódot.

## Ellenőrzött alapállapot

- A helyi beállításokkal elért adatbázis: 100 USD kezdőtőke, paper mód, 0,09354296 USD készpénz.
- 174 BUY és 4 SELL; ebből 164 BUY `ai` eredettel, 10 régebbi BUY eredetjelölés nélkül. Az eladások: 1 take-profit és 3 stop-loss. A vétel/eladás darabszámarány önmagában nem hozammutató, mert több vétel összevonható egy pozícióba.
- Nyitott BTC: 0,001688317 BTC; nyitott ETH: 0,000008429329 ETH. A portfólió lényegében BTC-be koncentrálódott; az adat nem aktuális tőzsdei egyenleg.
- Utolsó döntés: 2026-07-21 09:35 UTC. Az utolsó folyamatnaplóban 0,010393663 USD BTC-vétel és üres ML-jellista szerepel. Ez nem jelenti, hogy minden korábbi tickben hiányzott az ML.
- Az utolsó öt lekért GitHub-futás sikertelen, a legutolsó július 25-i; a keretelfogyás okát a felhasználó közölte.
- A helyi modell logisztikus regresszió, nem a README-ben említett LightGBM. Tárolt test AUC: 0,54488; pontosság: 52,78%, szemben az ugyanazon tesztadatból számítható 51,47%-os többségi alapvonallal. Ezek korábbi tréningmetrikák, nem most mért kereskedési nyereség.
- `pnpm test`: 39 fájl, 182 sikeres teszt. Három további tiszta függvényes próba lent. Nem futott új hozam-backtest vagy éles végrehajtási teszt.

## Bizonyított hibák és következményeik

### 1. A 20%-os limit nem az összesített pozíciót korlátozza

`src/lib/risk/risk-manager.ts:44` az új döntés százalékát nézi; nem számolja hozzá a meglévő pozíció értékét. A `tick.ts:435` a készpénzből számolja a vételt.

Reprodukció: 100 USD equity, 20 USD BTC, 80 USD cash, 20%-os BUY → az ellenőrzés módosítás nélkül átenged 16 USD vételt → 36% BTC-kitettség. Az ismételt vételek tovább koncentrálnak. A korai visszatérés nagy BUY visszavágásakor a következő pozíciószám-ellenőrzést is átugorja.

Javítás: minden BUY-ra ugyanaz a közös kapu, `max(0, equity * maxPositionPct - existingPositionValue)` szabad kerettel; készpénz, teljes portfóliókockázat és darabszám együttes ellenőrzése. Ez fegyelmezett tőkefelhasználás, nem garantált hozamnövelés.

### 2. Az AI eladási mérete a készpénztől függ

A `tick.ts:435` BUY és SELL esetén is `cashUsd * amountPct` összeget képez. Ha majdnem minden tőke pozícióban van, az AI csak apró összeget tud eladni. A végrehajtási méretet SELL esetén a birtokolt mennyiségből kell számítani, a százalék jelentését egyértelműsíteni kell.

A `PaperBroker` a SELL-nél is a díjjal csökkentett összegből képez mennyiséget, és nem tiltja megfelelően a nem birtokolt/túlméretes eladást. Külön BUY- és SELL-elszámolás szükséges.

### 3. A demó profit és a backtest nincs azonos elszámoláson

- `accounting.ts:226`: az eladás teljes bruttó összegét hozzáadja a készpénzhez, az eladási díjat nem vonja le. A tick munkaállapota ugyanezt teszi.
- `backtest/engine.ts:152`: helyesen nettó eladási összeget ír a készpénzhez. Ezért a két motor már a díjak miatt is eltér.
- `tick.ts:337`: automatikus stopnál a korábbi stopárat használja papír teljesülési árnak, akkor is, ha az aktuális ár alacsonyabb. Példa: 95-ös stop és 90-es észlelt ár mellett 95-ös papíreladás. Ez túlságosan kedvező modellezés; tényleges piaci megbízásnál a tőzsdei teljesülés számít.
- Az analitika a lezárt pozícióknál levonja a SELL díját, ezért a kijelzett realizált eredmény és a készpénzkönyvelés is eltérhet.

Javítás: egységes készlet- és díjmodell, végrehajtható vételi/eladási ár, csúszás és részleges teljesülés kezelése. A korábbi profitot ezután újra kell számítani a rendelkezésre álló adatok korlátain belül.

### 4. A napi veszteségkorlát és a DCA-kapu hibás

- `tick.ts:181`: napi hozam helyett `equity / initialCapital - 1` szerepel. A kezdőegyenleg helyett a nap eleji equity és a pénzmozgások szükségesek.
- A risk manager a SELL-t is HOLD-ra cseréli veszteségküszöbnél. A kockázatcsökkentő zárást át kell engedni; új kockázat vállalását kell tiltani.
- A kódalapú DCA közvetlenül kerül végrehajtásra, az AI risk managerét megkerülve.
- `fear-greedy.ts:61`: csak azt vizsgálja, pozitív-e a heti maradék. Reprodukció: 1 USD maradék keret mellett 2 USD vételt tervez.
- `weekly-budget.ts` a DCA-keretből minden paper BUY-t levon, nem csak a DCA-t; live kötéseket pedig nem számol bele.
- Rávásárláskor a stop újra beállítódik, és az addig felhúzott trailing stop lejjebb kerülhet (`accounting.ts:181`).

### 5. A tanított és a futó piaci adatok eltérnek

`collectors/binance.ts` 24 gyertyát kér, megtartja a még nem lezárt gyertyát is, és annak jövőbeli zárási időpontját adja timestampnek. A tick a legnagyobb timestampet választja aktuális árnak. A `buildFeatures` összekeveri a Binance órás mennyiséget a CoinGecko 24 órás volumenével, és a visszatekintést elemszámmal méri.

Javítás: csak lezárt, idő szerint rendezett, egységes tőzsdei OHLCV a modellezéshez; külön friss, végrehajtható ár a kötéshez; hiányzó/elavult adat explicit állapot. Valódi high/low megtartása az ATR-hez. Ugyanaz a feature-képzés tréningkor és futáskor.

### 6. A momentum nem kapcsolható be pusztán egy flaggel

A stratégia `momentumEnabled: false`, 48 gyertyás visszatekintéssel. A collector 24-et ad. Reprodukció: egy végig emelkedő 24 elemű sorra a jelenlegi 24/48 beállítás `false` eredményt ad.

Előbb elegendő lezárt gyertya és azonos live/backtest adatút kell. Utána vizsgálható, ad-e értéket a trendben történő vétel a fear-DCA mellé.

### 7. A backtest nem a teljes működő botot teszteli

A `backtest/engine.ts:192` AI-policyja HOLD. A történelmi teszt a kódalapú ciklust méri, miközben a naplózott új vételek döntően AI-ból származnak. A jó DCA-backtest ezért nem igazolja a teljes botot.

További korlátok:

- A backtest a teljes gyertya high/low-ján reagál, a futó bot óránként egy spot pillanatképet lát.
- A lezárt trade statisztikája a végső eladást számolja, díjak nélkül; korábbi részleges profitkivételek nem jelennek meg teljes round-tripként a profit factorban/hit rate-ben. Az equity-görbe ettől külön kezeli a készpénzt.
- A tournament 3024 konfiguráció közül a tesztszakasz teljesítményét is használva választ. Ez a szakasz így validációs adat, nem független végső teszt. A „robust” mód sem állítja vissza a függetlenségét.

## Javasolt fejlesztési sorrend

### A. Megbízható mérés és végrehajtás

Először közös risk/elszámolási út minden ordernek, helyes SELL, összesített pozíciólimit, nap eleji equity, végrehajtási minimumok és adategységesítés. Atomi DB-tranzakció és megbízásazonosító szükséges: a jelenlegi „előbb megnézem, később beírom” órás dedup nem véd két egyidejű futótól, és egy részleges DB-hiba újrapróbáláskor duplázást okozhat.

A BinanceBrokerben az exchangeInfo szerinti kerekítés, a díj eszközének kezelése, a védőmegbízások követése/törlése/cseréje és az egyenleg egyeztetése még külön feladat. A DB trailing stop frissítése önmagában nem módosítja a tőzsdén lévő stopot.

### B. Gyorsabb kilépés, külön a belépőktől

Kísérleti cél: 1–5 percenkénti stop/take-profit/trailing ellenőrzés, LLM nélkül; új pozíciók vizsgálata külön 15/60 perces lezárt gyertyákon. Ezek tesztelendő gyakoriságok, nem bizonyított optimumok.

Ideális szabályos pollingnál az észlelési várakozás 60 perces ciklusban átlagosan 30 perc, 5 percesben 2,5 perc, feltéve, hogy a trigger egyenletes időben érkezik. Ez 12-szer rövidebb várakozás, nem 12-szer több profit. A sűrűbb trailing szorosabban követhet és több korai zárást is okozhat; változatlan szabályokon kell összehasonlítani.

A gyors kilépés friss árra várjon, ne RSS-re, sentimentre vagy LLM-re. Jelenleg a profitciklus előtt az összes collector befejezését megvárja a motor. Állandó worker, egységes zárolás, adatfrissesség-mérés és időkorlátos hálózati hívások szükségesek. Hostingot a valós havi költség alapján válasszunk; jelen vizsgálat nem választott előfizetést.

### C. Jobb belépők — kis számú, előre kijelölt kísérlet

Azonos költség- és kockázati feltételekkel hasonlítsuk össze:

1. Javított jelenlegi fear-DCA alapvonal.
2. Trend/momentum stratégia megfelelő adatelőzménnyel.
3. Piaci állapot szerint váltó változat: emelkedő trendben momentum, oldalazásban külön validált visszatérés az átlaghoz, csökkenő trendben visszafogott vagy tiltott új vétel.
4. Szabályalapú belépők AI nélkül, majd ugyanaz AI-szűrővel, hogy látszódjon az AI hozzáadott nettó értéke.

Az AI jelenleg a portfólió belépési árait nullaként kapja (`tick.ts:379`); ezt az összehasonlítás előtt javítani kell. Az LLM confidence nem kalibrált találati valószínűség. Az LLM szerepe lehet hírek osztályozása és magyarázat; önálló orderdöntést csak akkor érdemes megtartani, ha a mérés igazolja.

Nem érdemes egyszerre stopot lazítani, keretet emelni és gyakoriságot változtatni: a javulás vagy romlás oka elveszne.

### D. Profitcél és elfogadási feltétel

Optimalizálandó: realizált és nem realizált nettó eredmény, mínusz kereskedési és működési költség, előre rögzített visszaesési korláton belül. A vállalható veszteséget a felhasználóval kell rögzíteni a tényleges stratégiahangolás előtt; itt nem emeltünk kockázati limiteket.

100 USD tőkén egy 2 USD pozíció +10%-os árfolyamnyeresége 0,20 USD költségek előtt. Egy 20 USD pozícióé 2 USD. Egy hipotetikus havi 5 USD működési költség önmagában 5% havi számlahozamot igényelne a nullszaldóhoz. Ez költségpélda, nem a jelenlegi szolgáltatások mért díja és nem hozamígéret.

A mostani backtest-feltételezés 0,1% díj és 5 bázispont csúszás oldalanként: egy oda-vissza kötés költsége nagyságrendileg 0,3% a megforgatott tőkére, spread és fix működési költség előtt. A kis ármozgásokat célzó sűrű kereskedéshez ezt meghaladó bizonyított előny kell.

Elfogadás: időben gördülő tanítás/validálás, külön érintetlen végső teszt, a költségek emelésével stresszteszt, készpénz és BTC buy-and-hold alapvonal, nettó eredmény/legnagyobb visszaesés/tőkekitettség/forgási sebesség jelentés. A gyorsabb kilépést azonos belépőkkel, finomabb idősoros adaton külön kell mérni. Ezután előremenő paper összevetés elegendő független lezárt kötésig; néhány nap és 4 eladás nem alkalmas tartós előny bizonyítására.

## Hivatalos külső források

- [GitHub: ütemezési késések](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows): a schedule késhet terhelés alatt; ebből következően a pontos gyors kilépést külön workerben javasolt vizsgálni. Ez nem a felhasználó keretelfogyásának diagnózisa.
- [Binance Spot filters](https://github.com/binance/binance-spot-api-docs/blob/master/filters.md): PRICE_FILTER, LOT_SIZE és notional feltételek. A konkrét minimális összegeket az aktuális exchangeInfo-ból kell venni.
- [Binance Spot market streams](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md): piaci adatfolyam és a lezárt gyertya jelzése; folyamatos adatkapcsolathoz újracsatlakozás és frissességellenőrzés is kell.

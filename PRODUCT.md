# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Egyetlen operátor: a rendszer tulajdonosa és fejlesztője. Naponta egyszer-kétszer ránéz,
hogy **mit csinált a bot** — nem kereskedik kézzel, és nem a felületről állítja a
stratégiát. A felület használati módja tehát OLVASÁS: állapot, pozíciók, döntések, hibák.

A beavatkozás (indítás, leállítás, paraméter-váltás) kódban és környezeti változóban
történik, nem a dashboardon; az admin-műveletek léteznek, de nem a napi út részei.

## Product Purpose

Személyes, mérés-vezérelt kereskedő rendszer papír-módban (paper trading). Két, egymástól
teljesen elkülönített sáv fut:

- **Kriptó** — BTC/ETH/SOL, USDT-elszámolás, óránkénti ciklus, fear-DCA + momentum belépő,
  opcionális LLM-döntéstámogatás.
- **Részvény** — AAPL/MSFT/NVDA/SPY, USD-elszámolás, amerikai ülés alatt 5 perces day
  trading, nap végére kötelezően laposra zárva (nincs overnight kitettség).

A siker nem „nyereséges nap", hanem hogy **a rendszer viselkedése hűen látszik**: mit
döntött, miért, mi tiltotta le, és mi maradt nyitva.

## Positioning

A rendszer megkülönböztető vonása nem a stratégia, hanem a **bizonyítási fegyelem**:

- minden stratégiai állítás mögött mérés áll, `ADOPT / REJECT / UNDECIDED` címkével;
- a kockázati kapuk (napi veszteség-latch, pozíciólimit, heti keret, adat-frissesség)
  UGYANAZOK a backtesztben és az élő ciklusban;
- adathiányt sosem oldunk fel kitalált árral vagy kitalált eredménnyel.

## Operating Context

- Next.js 14 app a Vercelen, Neon Postgres adatbázissal; a ciklusokat cron hívja.
- **Paper mód**: valódi pénz nincs a rendszerben. A kriptó sáv él, a részvény sáv kódban
  kész, de az ütemezője még nincs élesítve (`MARKETS_ENABLE_STOCKS` nincs beállítva) —
  ezért a felületen „készenlét" állapotban áll.
- A két sáv KÜLÖN pénztárcát vezet (USDT és USD), és a napi kapuik is külön élnek.
- A felület nyelve magyar, a szakkifejezések angolul maradnak (equity, stop, take-profit).
- Adatforrások: Binance (kriptó gyertya), Yahoo chart (részvény gyertya, kulcs nélkül),
  Finnhub (gyorsjelentés-naptár), Alpaca (kereskedési metaadat, paper-számla).

## Capabilities and Constraints

- A dashboard két API-ból olvas: `/api/portfolio` (pénztárcák, pozíciók, kötések) és
  `/api/market` (árak, Fear&Greed, ML-jel, kockázati konfiguráció, heti keret).
- Megjelenített tartalom: equity és P&L sávonként, pozíciók élő értékkel, döntés-napló a
  teljes érveléssel, kockázati limitek, trade-napló, ML-jel minőség, backteszt-futtató,
  árnyék-variánsok, admin-műveletek.
- Adatbázis nélkül a felület nem fabrikál számokat: „—" és explicit offline állapot.
- Használati kontextus: **nagy monitor, laptop ÉS telefon** — mindhármon olvasható kell
  legyen; a telefon nem másodlagos.
- A rendszer nem ad tanácsot és nem ígér hozamot; a felület sem sugallhat ilyet.

## Brand Commitments

Meglévő, megtartandó vizuális világ: **„trading terminál"** — mély, neutrális fekete alap
(`#0a0c0f`), amber/arany akcentus (`#e3a542`) a kriptó és rendszer-jelzésekhez, kék (`#5b9bd5`)
a részvény sávhoz, zöld/piros csak VALÓDI nyereséghez és veszteséghez. Tipográfia: Space
Grotesk (display), IBM Plex Sans (szöveg), IBM Plex Mono (minden szám). A számok
monospace-ben, tabuláris számjegyekkel állnak.

## Evidence on Hand

- Mérési jelentések a `docs/` mappában (stratégia-verseny, day trading, momentum-rangsor,
  javítási terv) — ezek a valódi, hivatkozható eredmények.
- 1045 automata teszt, `tsc` tiszta.
- NINCS élő kereskedési előzmény, nincs valódi hozam-eredmény, nincs külső felhasználó és
  nincs referencia. Ilyet a felület nem állíthat.

## Product Principles

1. **Az őszinte állapot fontosabb a szép számnál.** Nulla kötés, negatív nap és „nem futott
   le" ugyanúgy elsőrangú állapot, mint egy nyereséges nap.
2. **Minden szám mögött legyen forrás.** Ami nem mérhető, az „—", nem nulla.
3. **A két sáv külön él.** Külön pénztárca, külön kapu, külön kockázat — a felületen sem
   keveredhet.
4. **A napi út olvasás.** A beavatkozó és elemző eszközök léteznek, de nem tolakodhatnak a
   napi ellenőrzés elé.
5. **A sűrűség nem öncél.** Terminál-esztétika igen, de a hierarchiának egy pillantás alatt
   működnie kell.

## Accessibility & Inclusion

Sötét felület, tartós kontraszt-igény: a másodlagos szövegek se essenek olvashatatlanul
halványra. Nyereség/veszteség nem jelölhető KIZÁRÓLAG színnel — előjel vagy címke is kell,
mert a piros/zöld a leggyakoribb színtévesztés-tengely.

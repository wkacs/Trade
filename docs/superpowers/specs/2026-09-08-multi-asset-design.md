# Multi-asset bővítés — design & roadmap (crypto + részvény)

**Státusz:** aktív fejlesztés · **Mód:** kizárólag **paper** · **Dátum:** 2026-09-08
**Ág:** `claude/crypto-exchange-forex-integration-fdcw64`

> Ez a dokumentum a projekt kripto-only felépítéséből egy **több-eszközosztályú
> (multi-asset)** rendszerbe való átállás tervét írja le. A cél **nem** a „nagyobb
> profit" vagy „magabiztosabb" döntés önmagában — több piac elsősorban **diverzifikációt**
> ad, cserébe több adatforrást, több hibalehetőséget és nagyobb túlillesztés-kockázatot.
> Az elv változatlan: minden döntés **visszavezethető** legyen.

---

## 1. Miért refaktor, és nem gyors hozzáadás

A mostani kód mélyen a kripto + Binance feltételezésre épül:

- `COIN_UNIVERSE = ["BTC","ETH","SOL"]` ~30 helyről hivatkozva (engine, execution,
  backtest, scriptek).
- Piaci adat: Binance `klines` és `bookTicker`, USDT-pár, 0/24 nyitás.
- Végrehajtás: `binance-*` broker, USDT quote.
- Gyűjtők: kripto-specifikusak (CoinGecko, Fear&Greed, whale/on-chain, derivatives).

Egy „big-bang" átírás megkockáztatná a működő kripto-ágat. Ezért **additív, réteges**
utat viszünk: új `src/lib/markets/` alapréteg, ami az eszközosztályt (asset class)
első osztályú fogalommá teszi, és a meglévő kripto-út **változatlanul** fut tovább,
amíg a runtime kifejezetten be nem kapcsolja az új instrumentumokat.

## 2. Eszközosztályok és döntések

| Eszközosztály | Adatforrás (ingyenes, kulcs nélkül) | Nyitvatartás | Timeframe | Quote |
|---|---|---|---|---|
| `crypto` | Binance klines/bookTicker + CoinGecko *(meglévő)* | 0/24 | `1h` | USDT |
| `stock` | **Stooq** CSV (`stooq.com/q/d/l/`), kulcs nélkül | US szabályos ülés, H–P | `1d` | USD |

**Miért Stooq részvényhez:** ingyenes, kulcs nélküli, CSV-ben ad megbízható **napi**
OHLCV-t (`Date,Open,High,Low,Close,Volume`). A kulcs nélküli intraday részvényadat
megbízhatatlan, ezért a részvény-ág **napi gyertyán** dönt — ami amúgy is jobban illik
a részvénypiac ritmusához, mint az órás kripto-tick. (Later opció: Alpaca paper API
kulccsal intraday + valós paper-végrehajtás — külön fázis.)

**Forex:** most **kimarad** (a felhasználó döntése). Az absztrakció úgy készül, hogy
később egy `forex` osztály hozzáadható legyen (más nyitvatartás ~24/5, tőkeáttétel,
pip/spread modell).

## 3. Fázisok

### Fázis 0 — Alapréteg *(ez a commit)*
Additív, tiszta, tesztelt modulok. Nem módosít futó viselkedést.

- `src/lib/markets/calendar.ts` — trading calendar. `crypto` mindig nyitva; US equity
  09:30–16:00 America/New_York, hétvége + US ünnepnapok. Időzóna az `Intl`
  API-val (nincs kézi DST-számolás).
- `src/lib/markets/registry.ts` — instrumentum-katalógus egyetlen igazságforrásként.
  Minden instrumentum hordozza: `symbol`, `assetClass`, `quote`, `dataProvider`,
  `displayName`. A **katalógus** bővül, de az **aktív** univerzum env-vezérelt és
  alapból pontosan a mai kripto-kosár (BTC/ETH/SOL) — így a runtime nem változik.
- `src/lib/markets/stooq.ts` — Stooq napi OHLCV provider `OhlcvCandle`-re normalizálva,
  ugyanazzal a „csak lezárt gyertya" fegyelemmel, mint a Binance-út.

### Fázis 1 — Adat-integráció
- A `stock` instrumentumok bekötése a piaci-adat rétegbe (`market/candles` mellé egy
  provider-választó, ami asset class alapján Binance vagy Stooq).
- Kvótázás/ár-frissesség: részvénynél a napi close az „ár", a `quotes.ts` bid/ask útját
  a calendar zárt-állapota váltja ki (zárt piacon nincs friss jegyzés → HOLD).

### Fázis 2 — Végrehajtás (paper)
- Asset-class-tudatos paper-broker: a `paper-fill` / `paper-broker` általánosítása
  nem-USDT quote-ra és részvény tick-size/lot szabályokra (Stooq nem ad exchange-filtert,
  ezért konzervatív alapértékek + kerekítés).
- A `risk-manager` és `sizing` már ma is decimális, quote-agnosztikus — átvizsgálandó,
  hogy a `maxPositionPct`, stop, TP részvényre is helyesen áll.

### Fázis 3 — Ütemező & piac-nyitvatartás
- A tick tudja, mely instrumentumok **kereskedhetők most**: kriptó minden órában;
  részvény csak nyitott ülés + friss napi close után, egyszer/nap.
- Zárt piacnál az adott instrumentum kimarad a döntésből (nem hiba, hanem `HOLD`
  „piac zárva" indokkal).

### Fázis 4 — Stratégia, ML, backteszt
- Az ML modell **per asset class** (a kripto-feature-ök nem érvényesek részvényre).
  Külön model.json / külön karantén. Addig: LLM + kód-szabályok, ahogy most.
- Backteszt-loader asset-class-tudatos (Stooq napi történet részvényhez).

## 4. Amit ez a bővítés NEM ígér

- **Nem** garantál nagyobb profitot. Több eszköz ≠ több nyereség; a `confidence`
  mező továbbra sem kalibrált valószínűség.
- **Nem** kapcsol élesre semmit. `TRADING_MODE=paper` marad; a live út részvényhez
  nincs megírva és nincs verifikálva.
- **Nem** változtat a kockázati limiteken. A `-5%` stop, `20%` max pozíció, napi
  circuit breaker az új osztályokra is érvényes.

## 5. Backward-kompatibilitás

- `COIN_UNIVERSE` és `CoinSymbol` **változatlanul** marad; a registry ezekből származtatja
  a kripto instrumentumokat.
- Új instrumentum aktiválása kizárólag env-flaggel (`MARKETS_ENABLE_STOCKS`,
  `MARKETS_EXTRA_CRYPTO`) — alapból ki, tehát a jelenlegi óránkénti kripto-tick és a
  tesztek viselkedése nem változik.

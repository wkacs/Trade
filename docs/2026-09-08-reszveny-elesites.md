# Részvény-sáv élesítés — mi volt elromolva és mi a helyzet most

**Dátum:** 2026-09-08 · **Mód:** paper (`TRADING_MODE=paper`) · **Érintett ág:** `master`

A részvény-sáv kódja 2026-09-08 délelőtt bekerült a repóba (PR #1, `ddf079c`), de
**egyetlen kereskedést sem tudott végrehajtani**. Négy egymásra rakódó blokkoló volt;
mind a négy javítva. A negyedik a KRIPTO ágat is bénította.

## 1. A négy blokkoló

| # | hol | tünet | ok | javítás |
|---|---|---|---|---|
| 1 | adat | minden részvény `bad_payload: Stooq nem-CSV válasz` | a Stooq CSV-végpontja JS proof-of-work bot-ellenőrzés mögé került, HTML-t ad | `markets/yahoo` provider (Yahoo chart API, kulcs nélkül, JSON) — `5692614` |
| 2 | jel | 128 letöltött napi gyertyából 5 „hézagmentes" bar a kért 48 helyett → `sufficient: false`, örök tétlenség | a `contiguousTail` FIX ms-távolságot vár; a napi részvény-bar hétvégén 3 nap, ünnepnapon 4, DST-váltáskor ±1 óra | naptár-alapú rács (`toSignalCandles` + `previousTradingDayKey`) — `feef51d` |
| 3 | stratégia | jó jelek mellett is 0 rendelés | a DCA-kapu kripto Fear&Greed ≤ 20-at vár (a részvénynek nincs ilyen jele), a momentum-belépő pedig alapból KI | `STOCK_STRATEGY` (momentum BE, tétel 10%) — `0729ae0` |
| 4 | könyvelés | `PersistenceError: write_failed`, `ledger_cash_amount_non_negative` | a PostgreSQL a CHECK-et a JAVASOLT insert-soron is nézi az `ON CONFLICT` előtt → minden negatív cash-delta (= minden BUY) és minden SELL pozíció-delta elhasalt | `0008_nonneg_upsert_fix` migráció — `0729ae0` |

### A 4-es blokkoló következménye a kripto ágra

A javítás előtt a teljes adatbázisban **nulla `execution_fills` és nulla `trades` sor**
volt. A kripto bot tehát a júniusi indulás óta **soha nem könyvelt el egyetlen vételt
sem** — „döntött", de a perzisztencia mindig elhalt. Ez megmagyarázza, miért állt a
fő számla készpénze változatlanul 319,71 USD-n és miért mutattak az árnyék-sávok
tétlenséget. A migráció óta a kripto ág is tud könyvelni; a következő órás tick az első,
amelyik valóban vásárolhat.

## 2. Miért Yahoo, és mi lett a Stooq-kal

A Yahoo `chart` végpont (`query1.finance.yahoo.com/v8/finance/chart/AAPL?range=6mo&interval=1d`)
kulcs és süti nélkül ad napi OHLCV-t JSON-ban. Ugyanaz a fegyelem érvényes rá, mint a
Binance-útra: **csak lezárt gyertya** kerül be, a lezártságot a naptár dönti el, a hiba
strukturált (HTTP, nem-JSON, Yahoo-oldali hibaüzenet, hálózat).

A `markets/stooq` modul és tesztjei **megmaradtak**, de nincsenek az élő úton. Ha a
Stooq bot-fala eltűnik, a registry `dataProvider` mezőjének átállítása elég.

## 3. A részvény-stratégia (STOCK_STRATEGY)

A kripto `DEFAULT_STRATEGY`-ből, két szándékos eltéréssel:

- `momentumEnabled: true` — a részvény-sávnak ez az EGYETLEN belépő útja (a fear-DCA
  kapuja kripto-jelre épül).
- `momentumBuyPct: 0.10` — a paper-fill egész részvény lotot enged (a Yahoo nem ad
  `exchangeInfo`-t), és 10 000 USD-n a kripto 2%-os tétele 200 USD = 0 darab SPY
  (~770 USD) vagy NVDA (~230 USD). 10% ~1000 USD, azaz 1 SPY / 4 NVDA.

**Nem tágult a kockázat:** 20% max pozíció, 3 egyidejű pozíció, 5% stop, 10%
take-profit, napi circuit breaker — mind változatlan. A belépő jel: breakout, azaz a
záróár az SMA(24 ülés) fölött ÉS a 48 ülés maximuma.

## 4. A sáv mai állapota

- Univerzum: AAPL, MSFT, NVDA, SPY (Yahoo, napi gyertya, USD).
- Pénztárca: külön `stock-paper` USD-ledger, seed 10 000 USD (`STOCK_PAPER_CAPITAL_USD`).
- **Első valódi trade:** momentum BUY **NVDA 4 db, 922,13 USD**, készpénz 10 000 → 9 077,87 USD.
- Ütemezés: `daily-stock-tick` workflow, hétköznap 22:30 UTC (US-zárás után), napi lease
  zárja ki a dupla futást.

## 5. Élesítéshez szükséges kapcsolók

| hol | kulcs | érték | mire kell |
|---|---|---|---|
| GitHub repo **variable** | `MARKETS_ENABLE_STOCKS` | `1` | enélkül a napi workflow ZÖLDEN kihagyja magát (nincs aktív részvény) |
| GitHub repo variable (opcionális) | `STOCK_PAPER_CAPITAL_USD` | `10000` | csak az ELSŐ seedet dönti el; a pénztárca már seedelve van |
| Vercel env (production) | `MARKETS_ENABLE_STOCKS` | `1` | a `/api/cron/stock-tick` kézi trigger és a jövőbeli Vercel-ütemezés |

A dashboard részvény-sávja NEM függ a flagtől: a `stock-paper` ledgert olvassa, tehát a
seed óta élő pénztárcát mutat.

## 6. Ami nyitva maradt

- **Az intent-azonosító naponta determinisztikus** (`<ET-dátum>-stock-<origin>-<n>`).
  A napi lease miatt ez normál üzemben nem gond, de `--force` melletti ismételt futás
  ugyanazt a `fill_key`-t adná → a második teljesülés duplikátumként no-op.
- **Integrációs tesztek**: a `tests/integration/accounting.test.ts` pontosan a 4-es
  blokkolót fedné le, de `TEST_DATABASE_URL` nélkül soha nem futott. Egy eldobható Neon
  branch beállítása CI-ben megfogta volna a hibát.
- **Részvény-ML és LLM-belépő**: nincs. A sáv tiszta kód-szabály szerint megy.
- **Élő (nem paper) részvény-út**: nincs megírva, nincs verifikálva.

# Profit‑boost ötlettár — külső trader‑repók elemzése

**Dátum:** 2026‑06‑26
**Készítette:** Claude (kérésre)
**Cél:** Öt nyilvános trading‑repo átvizsgálása, és konkrét, a saját botunkra (`ai-crypto-trader`) átemelhető ötletek kiszűrése, amelyek a **profit‑esélyt** növelhetik — logika, API‑minták, architektúra szinten. Nem implementációs terv, hanem rangsorolt ötlettár; a kiválasztott pontokhoz külön spec/plan készül.

**Frissítés (2026‑06‑26):** a doksi tartalmazza a **GLM 5.2 független ajánlásának keresztellenőrzését** és a két elemzés **egyesített prioritását** (lásd lent). GLM 5.2 szintén beleolvasott a kódba; a tárgyi állításait fájl/sor szinten verifikáltuk.

## Vizsgált repók

| # | Repo | Stack / licenc |
|---|---|---|
| 1 | https://github.com/nautechsystems/nautilus_trader | Rust + Python, LGPL‑3.0 |
| 2 | https://github.com/HKUDS/AI-Trader | Python/FastAPI + React |
| 3 | https://github.com/bitcoinvsalts/node-binance-trader | Node/TS (archivált) |
| 4 | https://github.com/yasinkuyu/binance-trader | Python (régi, egyszerű) |
| 5 | https://github.com/timercrack/trader | C++/Python, CTP (kínai határidős) |

## Összefoglaló relevancia

| Repo | Profit‑relevancia | Fő tanulság |
|---|---|---|
| **nautilus_trader** | 🟢🟢🟢 magas | Backtest=live paritás, **OCO/bracket orderek**, pre‑trade risk engine, normalizált order‑modell |
| **AI‑Trader** | 🟢🟢 magas | **Variáns‑tournament + mark‑to‑market leaderboard**, multi‑agent LLM‑vita, experiment‑tracking |
| **node‑binance‑trader (NBT)** | 🟢 közepes | Nyers piaci adat rögzítése → backtest‑dataset; signal/execution szétválasztás; node Binance‑order minták |
| **yasinkuyu/binance‑trader** | 🟢 közepes | **Élő‑Binance gotchák**: LOT_SIZE/stepSize, MIN_NOTIONAL, PRICE_FILTER, partial fill, order‑state perzisztálás |
| **timercrack/trader** | 🔴 alacsony | Csak event‑bus + notification‑absztrakció ötlet; a piac/API más (CTP, határidős) |

---

## Repónkénti részletes megfigyelések

### 1. nautilus_trader — a „komoly" referencia
Production‑grade, event‑driven, multi‑venue motor. Rust‑mag + Python‑vezérlés. A legfontosabb tanulságok:

- **Backtest=live paritás:** ugyanaz a stratégia‑kód fut backtestben és élesben, *nulla* kódváltoztatással. Megszünteti a „kutatás → prod" fordítási rést.
- **OCO / OUO / OTO kontingencia‑orderek:** belépés + take‑profit + stop **egyetlen, tőzsdén pihenő ordercsomagként**. Ez intra‑hour is tüzel.
- **Fejlett time‑in‑force:** IOC, FOK, GTC, GTD, post‑only, reduce‑only, iceberg.
- **Pre‑trade risk engine:** minden order végrehajtás előtt validálva.
- **Normalizált order‑modell + adapter‑minta:** egységes reprezentáció 20+ tőzsdére (Binance, Coinbase, Deribit, dYdX, Hyperliquid…).
- **Determinista óramodell:** reprodukálható szimuláció.

> Licenc: LGPL‑3.0 — az **ötleteket/architektúrát** szabadon átveheted, a kódot ne másold zárt projektbe. A teljes motorra átállás (Python/Rust újraírás) nem éri meg; az elveket vidd át.

### 2. HKUDS/AI‑Trader — „agent‑native" platform
LLM‑ágensek együttműködési platformja (Python/FastAPI + React, PostgreSQL/SQLite). Tanulságok:

- **Variáns / experiment‑tracking** élő **mark‑to‑market scoringgal** és leaderboarddal — A/B‑teszteld a döntés‑variánsokat realizált PnL alapján.
- **Multi‑agent együttműködés / vita:** „collective intelligence" — ágensek publikálnak jelzéseket, vitáznak.
- **Skill‑alapú moduláris architektúra:** a trading‑logika független, újrahasznosítható komponensekre bontva.
- **Fallback adatforrások:** elsődleges/másodlagos ár‑feed a megbízhatóságért (Alpha Vantage → yfinance).

> A copy‑trading / „social network for agents" rész egy **személyes** botnál felesleges — csak a variáns‑tournament és a (cost‑tudatos) kritikus‑ágens ötlet releváns.

### 3. node‑binance‑trader (NBT) — a stack‑rokon
Node/TS, archivált, de jó referencia. Három komponens: **Server** (jelzés‑detektálás + nyers candle/depth/trade rögzítés PostgreSQL‑be), **Trader** (végrehajtás), **Backtest** (történelmi tick‑replay). Tanulságok:

- **Nyers piaci adat perzisztálása** → ebből épül a backtest‑dataset ÉS az ML‑újratanító‑készlet.
- **Signal‑generálás és execution szigorú szétválasztása** (ez nálunk megvan, de jó megerősítés).
- **Node Binance order‑minták** közvetlenül átültethetők a `binance-broker.ts`-be.

### 4. yasinkuyu/binance‑trader — az élő‑execution gyakorlat
Egyszerű, régi Python‑bot, de a **valódi Binance‑order mechanika** jól látszik benne:

- Tőzsdei szűrők tisztelete: **MIN_NOTIONAL, PRICE_FILTER, LOT_SIZE** precízió.
- **Partial fill** korrekt követése.
- **Order‑state perzisztálás** újraindításon át (SQLite).
- Profit‑target + stop‑loss konfigurálható százalékkal; mennyiség auto‑számítás a bázis‑összegből.

### 5. timercrack/trader — nagyrészt irreleváns
Kínai határidős (CTP) rendszer, C++/Python. A piac és az API más. Egyetlen átemelhető gondolat: **notification‑absztrakció** (WeChat → Telegram/Discord) és a config‑vezérelt setup. Profit‑szempontból elhanyagolható.

---

## A 6 konkrét húzás — profit‑hatás szerint rangsorolva

A fájlhivatkozások a saját kódbázisunkra (`src/…`) mutatnak.

### #1 — OCO/TP + intra‑candle stop‑szimuláció *(Nautilus)* — ⚠️ KORRIGÁLVA, lásd lent
> **Korrekció (2026‑06‑26, GLM 5.2 review nyomán):** az eredeti megfogalmazás túlértékelte ezt a pontot.
> Pontosítás a három execution‑path szerint:
> - **Live:** a `binance-broker.ts:98-116` **már most** letesz exchange‑oldali `STOP_LOSS_LIMIT`‑et a BUY után → a stop intra‑hour tüzel, cron‑tól függetlenül. Tehát „a bot óránkénti cronnal ellenőrzi a stopot" a live path‑ra **nem igaz**.
> - **Valódi maradék‑probléma (live):** a **take‑profit nincs exchange‑oldali orderként** (csak az SL ül a tőzsdén; a TP a tickben értékelődik) → ez valódi szivárgás. Megoldás: SL+TP **OCO‑ként** a Binance‑on. → ez a **P1 (broker hardening)** alá tartozik.
> - **Paper/backtest:** csak `currentPrice`-t lát, **nem szimulál intra‑candle high/low‑t**. Megoldás: gyertya high/low‑alapú kiütés. → ez a **P0 (backtest)** alá tartozik.
> - Megjegyzés a forráshoz: a korábban idézett „a mock csak az utolsó ár‑pontot látja" komment a **committed `HEAD:200`-ban** van (egy *teszt‑mock*‑setup leírása), és a függőben lévő diff épp **törli** — nem architekturális kijelentés, és nem az uncommitted állapotból való.
>
> **Tanulság:** ez nem önálló #1; a két valódi darabja feloldódik a P0‑ban és P1‑ben (lásd „Egyesített prioritás").

### #2 — Backtest = live paritás + nyers adat rögzítése *(Nautilus + NBT)* 🥈
**Probléma:** a backtest külön út (`/api/backtest`), nem ugyanaz a kód, mint a `runTick`. Becsületes realizált‑PnL nélkül a többi javítás nem mérhető.
**Megoldás:** a `runTick` döntéslogika legyen az EGYETLEN forrás, amit történelmi adaton visszajátszunk; **minden tick nyers piaci snapshotját** rögzítsük Neonba → ebből lesz valódi backtest‑adat és ML‑újratanító‑készlet.
**Érintett fájlok:** `src/app/api/backtest/route.ts`, új rögzítő lépés a `engine/tick.ts`-ben, `portfolio/evaluate.ts`

### #3 — Variáns‑tournament + mark‑to‑market leaderboard *(AI‑Trader)*
**Megoldás:** több döntés‑policy variánst (eltérő fear‑greed küszöb, TP‑szint, ML‑confidence vágás) **párhuzamosan paper módban**, realizált PnL szerint rangsorolva → győztes előléptetése. A meglévő „döntés‑utólagos kiértékelés" (eval) modulra épül.
**Érintett:** eval‑modul kiterjesztés + `src/db/schema.ts` (`variant_id` mező)

### #4 — Olcsó „medve‑ügyvéd" kritikus‑ágens a phase‑2 ELŐTT *(AI‑Trader / TradingAgents‑minta)*
**Megoldás:** egy bear‑case critic a belépés előtt megpróbálja **megcáfolni** a long‑tézist → kevesebb false‑positive entry. Költség‑tudatosan az **ingyenes glm‑4‑flash**-en fusson vétóként, ne a fizetős glm‑5.2-n.
**Érintett:** új lépés `src/lib/llm/` (phase1.5), bekötve `engine/tick.ts`

### #5 — Volatilitás‑arányos pozícióméret + ATR‑alapú stop *(általános)*
**Probléma:** a fix ‑5% stop és 20% pozíció figyelmen kívül hagyja a volatilitást (a SOL ≠ BTC).
**Megoldás:** ATR‑arányos stop‑távolság + vol‑skálázott pozícióméret → jobb kockázat‑arányos hozam.
**Érintett:** `src/lib/risk/risk-manager.ts`, `strategy/trailing-stop.ts`

### #6 — BinanceBroker élő‑élesítés checklist *(yasinkuyu + NBT)*
**Probléma:** a live BinanceBroker még nincs verifikálva; élesben ezek a gotchák kiütnek.
**Checklist:** `stepSize`/LOT_SIZE kerekítés, MIN_NOTIONAL, PRICE_FILTER tick‑size, **partial fill** kezelés, **order‑state reconciliation** újraindítás után (idempotencia).
**Érintett:** `src/lib/execution/binance-broker.ts`

---

---

## GLM 5.2 keresztellenőrzés

Egy második modell (GLM 5.2) függetlenül átnézte a kódot és párhuzamos ajánlást adott. A tárgyi
állításait fájl/sor szinten verifikáltuk — **mind igaznak bizonyult:**

| GLM 5.2 állítása | Verifikáció | Bizonyíték |
|---|---|---|
| `app/api/backtest/route.ts` naív confidence‑súly, „vázlat" | ✅ igaz | 16. sor: „Ez a vázlat"; 48–51. sor: `pnlPct += s.confidence * 0.01` — nincs fee, slippage, belépő/kilépő szimuláció |
| `ml/features.ts` csak 4 feature | ✅ igaz | 8–14. sor: `return1h, return4h, volatility4h, volumeRatio` |
| `ml/README.md` TODO: RSI/momentum/order‑book | ✅ igaz | 35. sor szó szerint |
| `execution/binance-broker.ts` sima `.toFixed()`, nincs LOT_SIZE/PRICE_FILTER/MIN_NOTIONAL | ✅ igaz | 84/105/107. sor; a kód **maga** is figyelmeztet rá (30–37. sor ⚠️) |
| DB az igazságforrás, nincs balance reconciliation | ✅ igaz | 35–37. sor komment elismeri |

**Korrekciók GLM 5.2‑höz (ahol árnyalni kell):**

1. **A „53%→55‑56% OOS" szám túl optimista.** A `ml/README.md` maga írja: ~52–53% OOS, és hogy az
   intraday kripto‑irány „nagyon nehéz". 4→12 feature **nem** vásárol megbízhatóan 2‑3 pontot;
   ~5000 óra/coin mellett overfitting‑kockázat. A feature‑bővítés **nem önálló prioritás, hanem a
   backtest alá rendelt** lépés — a README a LightGBM‑et is így kondicionálja: *„csak ha a backteszt
   indokolja"*. → backtest ELŐBB, edge‑javítás UTÁNA, mérve.
2. **A broker‑fix pontos töréspontja a védő STOP order, nem a vétel.** A MARKET BUY `quoteOrderQty`-vel
   megy (84. sor) → ott a LOT_SIZE stepSize nem üt ki. A valódi bukás a 98–109. soroknál a
   `STOP_LOSS_LIMIT` SELL: `quantity` (stepSize) + `price` (tickSize) — **ide** kell az
   `exchangeInfo`-alapú kerekítés.
3. **WebSocket‑et GLM helyesen tette utolsóra** — papír‑módban a REST‑tick olcsóbb és determinisztikusabb; csak sub‑perces belépésnél éri meg.

**Mit ad GLM 5.2, amit a fenti repó‑elemzés nem hangsúlyozott:**
- Backtest‑**realizmus**: fee + slippage + walk‑forward + Sharpe/max‑drawdown/hit‑rate report.
- Konkrét feature‑források TS/JS‑ben (RSI/MACD a binance‑trader‑ből, tulip‑indikátor a NBT‑ből).
- LLM‑lánc mélyítés: **tool‑use** (az LLM önállóan kér árat/order‑bookot), **reflection**, **memory**
  (a `decisions.outcome` visszacsatolás teljes lábra állítása).

**Mit ad a repó‑elemzés, amit GLM 5.2 nem hozott:**
- **Tőzsdei OCO/bracket + intra‑candle stop** — az óránkénti cron miatti veszteség‑szivárgás (a stop a
  következő tickig átszakadhat). GLM a backtest‑realizmust nézte, de ezt élesen nem mondta ki.
- **Variáns‑tournament + mark‑to‑market leaderboard** — empirikus profit‑szelekció.

---

## Egyesített prioritás (a két elemzés összevonva)

Rendezőelv: **profit‑hatás × mérhetőség**. A backtest azért P0, mert ő a *mérőműszer* — nélküle a P2/P3
javításokról nem tudod megmondani, segítettek‑e.

### P0 — Backtest‑motor (paritás + realizmus) — *ezzel kezdeni*
*Mindkét elemzés #1‑e.* A jelenlegi `backtest/route.ts` confidence‑súlyú vázlat → cseréld valódi motorra.
- **Paritás** (Nautilus): a `runTick` / pure stratégiák (`position-actions.ts`, `fear-greedy.ts`) **ugyanazon az OHLC‑n** újrajátszva — nulla kódeltérés backtest↔live.
- **Realizmus** (GLM/Nautilus): fee + slippage + **intra‑candle high/low fill** (ne a close‑szal), walk‑forward.
- **Report:** Sharpe, max‑drawdown, hit‑rate.
- **Adat:** minden tick nyers piaci snapshotja Neonba (NBT‑minta) → backtest‑adat ÉS ML‑retrain‑készlet.
- Érintett: `app/api/backtest/route.ts`, új rögzítő a `engine/tick.ts`-ben, `portfolio/evaluate.ts`

### P1 — Broker live‑hardening + OCO (valós pénz‑védelem)
*Mindkét elemzés flagelte.* Élesben ez most pénzt veszít.
- `exchangeInfo`-alapú **LOT_SIZE stepSize + PRICE_FILTER tickSize + MIN_NOTIONAL** kerekítés — célozva a `STOP_LOSS_LIMIT` SELL‑re (98–109. sor).
- **Balance reconciliation** Binance ↔ DB (a Binance az igazságforrás).
- **OCO/bracket order:** a stop+TP pihenő tőzsdei orderként (intra‑hour tüzel) — a cron‑szivárgás megszüntetése.
- Partial fill kezelés, order‑state perzisztálás/idempotencia újraindításon át.
- Érintett: `execution/binance-broker.ts`, `paper-broker.ts`, `strategy/trailing-stop.ts`

### P2 — Edge‑javítás (CSAK a P0 után, mérve)
- Feature‑bővítés (RSI, multi‑window momentum, order‑book) — **gated by backtest**, ne ígérj 2‑3 pontot.
- LightGBM — csak ha a logisztikus plafont elérte ÉS a backtest indokolja.
- **Variáns‑tournament + mark‑to‑market leaderboard** — empirikus szelekció (eval‑modul + `schema.ts` `variant_id`).
- ATR‑alapú, vol‑skálázott pozícióméret + stop.
- Érintett: `ml/features.ts`, `scripts/train-model.ts`, `risk/risk-manager.ts`, eval‑modul

### P3 — LLM‑lánc mélyítés (cost‑tudatosan)
- Olcsó **kritikus / bear‑ügyvéd ágens** a belépés előtt — az ingyenes **glm‑4‑flash**-en vétóként.
- **Tool‑use** (LLM önállóan kér árat/order‑bookot), **reflection**, **memory** (`decisions.outcome` teljes visszacsatolás).
- Érintett: új lépés `lib/llm/` (phase1.5), `engine/tick.ts`

### P4 — Halasztva / NEM
- **WebSocket / sub‑perces belépés** — csak ha leszállsz az óránkénti tickről (addig ne).
- **Nautilusra átállás** (Python/Rust újraírás, LGPL‑3.0) — NEM; csak az ötletek.
- **Copy‑trading / „social network for agents"** (AI‑Trader) — személyes botnál felesleges.
- **timercrack/CTP** — kihagyni (más piac/API).

## Hivatkozások
- Saját spec: `docs/superpowers/specs/2026-06-26-profit-cycle-design.md`
- Saját terv: `docs/superpowers/plans/2026-06-25-ai-crypto-trader.md`

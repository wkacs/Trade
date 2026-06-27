# Backtest‑motor — dizájn spec

**Dátum:** 2026‑06‑27
**Státusz:** jóváhagyott dizájn (implementáció előtt)
**Kapcsolódó:** `docs/superpowers/research/2026-06-26-profit-boost-external-repos.md` (P0 prioritás), `docs/superpowers/specs/2026-06-26-profit-cycle-design.md`

## 1. Cél és motiváció

A jelenlegi `app/api/backtest/route.ts` egy **vázlat**: a `predict` jelekből confidence‑súlyozott összeget képez (`pnlPct += confidence × 0.01`), fee/slippage/belépő‑kilépő szimuláció nélkül. Ez nem mond semmit arról, hogy a stratégia **valójában** profitábilis‑e.

Két független elemzés (Claude + GLM 5.2) egybehangzóan **P0‑ra** tette a valódi backtestet: ő a *mérőműszer*, ami nélkül a többi profit‑javítás (ATR‑sizing, variáns‑tournament, feature‑bővítés, ML‑hangolás) nem mérhető. Konkrét kiváltó ok: a bot paper módban veszteséges teszt‑trade‑eket csinált — backtest nélkül nem dönthető el, hogy ez **rossz regime** vagy **logikai bug**.

**Cél:** egy determinisztikus, reprodukálható backtest‑motor, amely a *pontosan ugyanazt* a kód‑alapú profit‑ciklust + Risk Managert futtatja, mint az éles bot, történelmi OHLC‑adaton, gyertya‑szintű kitöltés‑szimulációval, és becsületes teljesítmény‑metrikákat (Sharpe, max‑drawdown, hit‑rate) ad.

## 2. Scope

### Benne (MVP)
- A **determinisztikus motor** backtestje: ML `predict` + kód‑profit‑ciklus (stop‑loss / take‑profit / trailing / fear‑greedy DCA) + Risk Manager.
- Gyertya high/low‑alapú **intra‑candle** stop/TP kitöltés, fee + slippage modellel.
- Metrikák: total return, Sharpe, max‑drawdown, hit‑rate, trade‑szám, átlag win/loss, profit factor, exposure.
- A `runTick` döntés‑magjának kivonatolása tiszta, megosztott függvénybe (live + backtest egy forrás).

### Kívül (későbbi fázis)
- **LLM a backtestben** — az MVP kihagyja (nem determinisztikus + fizetős). A `Policy` port már most felkészíti az LLM‑proxy későbbi beültetésére.
- **Paraméter‑hangolás / variáns‑tournament** (P2) — a motor walk‑forward‑képes lesz, de a tournament külön spec.
- **ML‑újratanítás összekötése** a backtest‑adattal — külön feladat (a `data.ts` adatforrást viszont közösen használják).

## 3. Architektúra

**Vezérelv:** a `runTick` *agyát* kiemeljük egy I/O‑mentes magba, amit a **live tick ÉS a backtest is hív**. Az I/O (collect, DB, valódi broker, `Date.now`, LLM) a széleken marad → a döntés‑logika egy forrás, nincs drift, a backtest determinisztikus.

**Két „port" absztrakció:**
- **`Fill`** — hogyan lesz egy szándékolt orderből trade. *Live:* a broker (`PaperBroker`/`BinanceBroker`). *Backtest:* gyertya‑szimuláció (lásd §5).
- **`Policy`** — honnan jön az AI‑döntés (BUY/SELL/HOLD). *Live:* a 2‑fázisú LLM. *Backtest MVP‑default:* **`HOLD`** → a belépők kizárólag a kód‑alapú **DCA‑ból** jönnek, a stop/TP/trailing kezeli a kilépőket, így a backtest **pontosan a determinisztikus kód‑ciklust méri**. *Opcionális variáns:* egy determinisztikus ML‑jel‑szabály (összehasonlításhoz). (Az LLM‑proxy később ugyanide pluginolható.)

**Backtest‑konfiguráció:** kezdőtőke **default 10000 USD** (a paper‑fallbackkal egyezően, `PAPER_CAPITAL_FALLBACK_USD`), konfigurálható; symbols = `COIN_UNIVERSE` (BTC/ETH/SOL); slippage bps konfigurálható.

## 4. Komponensek

| Komponens | Új/refaktor | Felelősség |
|---|---|---|
| `src/lib/engine/decision-core.ts` | **kivonat a `runTick`‑ből** | Tiszta mag: `(state, snapshot, fill, policy, config) → { cycleActions, decision, trades, newState }`. A profit‑ciklus (stop→TP→DCA) döntés‑része + Risk Manager; az *execute* a `Fill` porton át. Nincs `Date.now`/IO/LLM. |
| `src/lib/backtest/engine.ts` | **új** | A hurok: minden órás gyertyára → MTM → `decision-core` → equity‑snapshot. Dátum‑tartomány‑split (walk‑forward) támogatással. |
| `src/lib/backtest/fill-sim.ts` | **új** | Gyertya high/low‑alapú kitöltés + fee (0.1%) + slippage (bps). A `Fill` port backtest‑implementációja. |
| `src/lib/backtest/data.ts` | **új** | Binance klines (1h OHLC) + történelmi Fear & Greed betöltése + cache (a `scripts/train-model.ts` mintájára). |
| `src/lib/backtest/metrics.ts` | **új, tiszta** | Total return, Sharpe, max‑drawdown, hit‑rate, trade‑szám, átlag win/loss, profit factor, exposure. |
| `src/lib/engine/tick.ts` | **refaktor** | A live út a `decision-core`‑t hívja, körülötte a valódi collect/DB/broker/LLM. Viselkedés változatlan → a 106 teszt zöld marad. |
| `scripts/backtest.ts` | **új** | CLI futtató: `pnpm tsx scripts/backtest.ts [--from --to --symbols]` → metrika‑riport. |
| `src/app/api/backtest/route.ts` | **átírás** | A naív confidence‑súly helyett a valódi motort futtatja (a UI BacktestPanel‑hez). |

## 5. Adatfolyam és `Fill` szabályok

### Per‑óra hurok (sorrend = a `runTick` tükre)
A hurok **per‑óra‑timestamp** lépked; minden órában a kosár (BTC/ETH/SOL) gyertyáit **időre illesztve** dolgozza fel (mint élesben a `collectAll` egy tickben több symbolt ad). Egy órán belül:
1. **MTM** — a pozíciók értéke a gyertya `close`‑ával; napi P&L frissítés.
2. **Stop/TP ellenőrzés** az *előző* gyertyából hozott `stopPrice` ellen, a *mostani* gyertya `low`/`high`‑jával.
3. **Trailing ratchet** — a `stopPrice` a mostani gyertya **`close`**‑ával kúszik feljebb a *következő* gyertyára.
4. **DCA** — fear‑greed + 24h változás alapján (market BUY).
5. **Policy döntés** (MVP: HOLD / ML‑szabály) → ha BUY/SELL: market order.
6. **Equity‑snapshot rögzítés** (cash + Σ qty×close) → drawdown/Sharpe görbe.

### `Fill` szabályok

| Order típus | Tüzel, ha | Kitöltési ár |
|---|---|---|
| **Stop‑loss** (SELL) | `low ≤ stopPrice` | `min(stopPrice, open) − slippage` — gap‑down esetén a rosszabb `open`‑on tölt |
| **Take‑profit** (SELL) | `high ≥ tpPrice` | `max(tpPrice, open) − slippage` — gap‑up a javadra tölthet |
| **Market** (DCA / AI BUY) | mindig | `close × (1 + slippage)` + 0.1% fee |
| **Market** (AI SELL) | mindig | `close × (1 − slippage)` − fee |

### Két konzervatív (pesszimista) szabály — egy backtest akkor ér valamit, ha inkább alábecsül
- **Stop ÉS TP egy gyertyán** (`low ≤ stop` és `high ≥ tp`): az 1h OHLC‑ból a bejárás sorrendje ismeretlen → **a stop tüzel előbb** (long esetén a rosszabb kimenet). Konfigurálható, default pesszimista.
- **A ratchet `close`‑t használ, nem `high`‑t.** A `high`‑val való kúsztatás ugyanazon a gyertyán a `low`‑val kiütne → „drágán vettem, olcsón adtam el egy órán belül" look‑ahead‑bug. A `close`‑alapú ratchet nincs előretekintés, és közel áll a live‑hoz (ott a spot‑ár ≈ az óra close‑ja).

### Adat‑függőségek
- **Binance klines** (1h OHLC) — ugyanaz a forrás, amit a `scripts/train-model.ts` már használ; teljes history; van high/low.
- **Történelmi Fear & Greed** — a DCA‑hoz; az `alternative.me` ingyenes *history* endpointjáról, időre illesztve a klines mellé.
- **Heti DCA‑keret** — nem DB‑ből, hanem **in‑memory gördülő 7 napos** összegként (a backtest‑store része).

## 6. Metrikák

| Metrika | Definíció |
|---|---|
| Total return % | `végEquity / kezdőtőke − 1` |
| Sharpe (annualizált) | `mean(órás hozam) / std(órás hozam) × √8760` (24/7 piac, kockázatmentes ráta = 0) |
| Max drawdown % | legnagyobb csúcs→völgy esés az equity‑görbén |
| Hit rate | nyereséges lezárt trade‑ek aránya |
| Trade‑szám, átlag win/loss, profit factor | a szignifikancia + aszimmetria |
| Exposure % | piacban töltött idő aránya (hogy a Sharpe ne legyen félrevezető kevés trade‑nél) |

## 7. Validáció — walk‑forward

- **MVP (determinisztikus ciklus, 0 hangolt paraméter):** a teljes history egyetlen menetben már eleve out‑of‑sample → egy full‑pass backtest becsületes.
- **P2‑től (tournament / TP‑szint / fear‑greed küszöb / ATR / ML hangolás):** train `[t0,t1]` → test `[t1,t2]` (OOS) → görget. A walk‑forward **vékony wrapper** a hurok fölött; az MVP egy passt futtat, de az `engine.ts` dátum‑split interfésze már kész rá.

## 8. Tesztelési terv (TDD)

1. **Paritás:** a `decision-core` kivonatolása **viselkedés‑megőrző** → a meglévő **106 teszt zöld marad** a bizonyíték. Plusz egy fókuszált teszt: ugyanaz a `(state, snapshot)` a régi úton és a magon át → azonos decision/trade.
2. **`fill-sim` unit‑tesztek** (mind a konzervatív ágat rögzíti): stop `low`‑érintésre tüzel; TP `high`‑ra; gap‑down → `open`‑on tölt; stop+TP egy gyertyán → stop nyer; ratchet `close`‑t használ; fee+slippage helyesen levonva.
3. **Engine‑teszt:** szintetikus ár‑sorozat ismert kimenettel (ár TP‑re fut → profit; stopra esik → loss) → equity‑görbe + hit‑rate stimmel.
4. **`metrics`‑teszt:** kézzel számolt hozam‑sorozat → ismert Sharpe/maxDD.
5. **Determinizmus‑teszt:** ugyanaz a bemenet kétszer → bitre azonos kimenet (a mag nem hív `Date.now`/`Math.random`/hálózatot; az idő a gyertyából jön).
6. **Regressziós „golden":** a teljes backtest egy fix historikus szeleten → a metrikák snapshotja regresszió‑őrként.

## 9. Nyitott pontok / jövő

- Az **LLM‑proxy** (determinisztikus szabály az LLM helyett) a `Policy` porton — külön, P2 feladat.
- A backtest‑adat **ML‑újratanításhoz** kötése (a `data.ts` közös, de a tréning‑pipeline külön).
- A **variáns‑tournament** (több policy paraméterezés rangsorolása realizált PnL szerint) — külön spec, erre épül.
- Slippage‑modell finomítása (fix bps → likviditás‑arányos) — csak ha a backtest indokolja.

## 10. Sikerkritérium

- A `pnpm tsx scripts/backtest.ts` lefut a teljes Binance‑historyn, és kiír egy metrika‑riportot (return, Sharpe, maxDD, hit‑rate, trade‑szám).
- A 106 meglévő teszt + az új backtest‑tesztek **mind zöldek**, `tsc` 0 hiba, `build` zöld.
- A riport megválaszolja: a kód‑alapú profit‑ciklusnak **pozitív vagy negatív** a várható értéke a múltban — ezzel eldől, hogy a veszteséges paper‑trade‑ek bug vagy regime kérdése.

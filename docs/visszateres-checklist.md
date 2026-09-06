# Visszatérési checklist — 2026-09-06 (esti állapot)

Egyetlen kérdésre válaszol: **mi fut most magától, mit kell megnézni, és mi maradt nyitva?**
Az állapot 2026-09-06 19:00 UTC szerinti. Minden parancs bármelyik gépről fut.

## 1. Mi fut magától

| mi | ütem | hol látszik |
|---|---|---|
| éles tick (AI-val, paper mód) | óránként :07 UTC | döntés-napló a dashboardon |
| kilépés-ciklus (stop / take-profit) | 5 percenként | `staleSkips`, pozíciók |
| L2 és L3 árnyék-mérés | óránként, a tick UTÁN | „Árnyék-mérés" panel |
| döntés-pontozás | ~1 órával a döntés után | a döntés-kártya alján |
| piaci kontextus mentése | óránként | `market_context` tábla |

Minden ingyenes szinten fut. Semmi nem kapcsol át automatikusan: ha egy jelölt nyer,
az élesítés kézi döntés marad.

## 2. A nap javításai

| commit | mit old meg |
|---|---|
| `cc414da` | a dashboard client-side exception-je (az UI a T20 előtti mezőneveket olvasta) |
| `03fbfb3` | a néma adatforrás-hiba: a collector hibája `ok: true, points: 0`-ként jelent meg |
| `db25e77` | Binance HTTP 451 → a függvények Frankfurtba (`fra1`) kerültek |
| `074e5a3` | a 30 s-os LLM-időkorlát vágta el a döntéseket (a GLM 30-53 s alatt válaszol) |
| `e693cab` | az AI-vétel némán elhalt, mert az ár elöregedett az LLM-szakasz alatt |
| `0c1ca02` | új, ortogonális adat: derivatíva-pozicionáltság és Coinbase-prémium |
| `e595771` | f3 feature-készlet — a promóciós kapu ELUTASÍTOTTA (AUC 0.526 < 0.53) |
| `f9f2dbd` | a tournament rácsa végre a BELÉPÉSI utat is variálja |
| `a9bd2ab` | kockázat-létra: mit vásárol és mit fizet a nagyobb kitettség |
| `5a8576a`, `72c5851` | L2 és L3 előre menő paper-mérése elindítva |
| `c628220` | „Árnyék-mérés" panel a dashboardon |
| `f4b0346` | a piaci kontextus saját története gyűlni kezd (`market_context`) |

## 3. Amit meg kell nézni visszatéréskor

### a) Elindult-e egyáltalán kereskedés

```bash
curl -s "https://trade-beryl-six.vercel.app/api/portfolio" | python -c "
import sys, json; d = json.load(sys.stdin)
print('készpénz', d['portfolio']['cashUsd'], '| pozíciók', len(d['positions']), '| tradek', len(d['recentTrades']))"
```

A fő számla 319.71 USD-ről indult, nyitott pozíció nélkül.

### b) Végrehajtódott-e AI-vétel (az ár-frissítés éles próbája)

```bash
curl -s "https://trade-beryl-six.vercel.app/api/ticks?limit=5" | python -c "
import sys, json
for t in json.load(sys.stdin)['ticks']:
    h = t['process']['health']
    print(t['ts'][:19], t['process']['decision']['action'], '| tradek', len(t['process']['trades']),
          '| stale', h['staleSkips'], '| frissítés', h.get('quoteRefreshes'))"
```

- `staleSkips` üres és `quoteRefreshes` nem üres → **a javítás bizonyítottan működik**.
- `staleSkips`-ben `stale` marad → a frissített ár is elavult volt; ez fail-closed, de nézd meg a quote-forrást.

### c) Az árnyék-mérés állása

A dashboard „Árnyék-mérés" panelje mutatja, vagy:

```bash
curl -s "https://trade-beryl-six.vercel.app/api/shadow" | python -c "
import sys, json
for l in json.load(sys.stdin)['lanes']:
    print(l['candidateId'], [(r['accountId'], r['equity'], r['netReturnPct'], r['roundTrips']) for r in l['rows']])"
```

**Számíts arra, hogy sokáig 320.00 USD lesz mindkettőn.** L2 félelem-kapuja FG ≤ 35 (az index
2026-09-06-án 73), L3 pedig 48 órás kitörést kér. A tétlenség a stratégia jelzése, nem hiba.

### d) Gyűlik-e a kontextus-adat

```bash
pnpm tsx -e "import {config} from 'dotenv';config({path:'.env.local'});(async()=>{const {getSql}=await import('@/db/client');const s=getSql();console.table(await s\`SELECT count(*) sorok, min(ts) elso, max(ts) utolso FROM market_context\`)})()"
```

Óránként 3 sornak kell keletkeznie (BTC, ETH, SOL). Ha áll a szám, a tick nem fut vagy a
derivatíva-források hibáznak — a TickInspector „Adatforrás" sora megmondja.

## 4. Nyitott tételek

| tétel | állapot |
|---|---|
| ML-karantén | **marad.** A f3 jelölt AUC-je 0.526, a kapu 0.53. Nincs ML-jel; a bot LLM + kód-szabályok alapján megy. |
| reaktív ML-jellemzők | a `market_context` most kezdte gyűjteni a történetet. Értelmes tanításhoz hónapok kellenek. |
| L2 / L3 adoptálása | a mérés végén KÉZI döntés. Cél: 30 nap vagy 50 lezárt kör. |
| valós pénz | `TRADING_MODE=paper`. A live Binance-út soha nem volt élesben verifikálva. |
| AI-út edge-e | egyetlen pontozott döntés van (`✓ eltalálta az irányt · +0.18%`). Ebből semmi nem következik. |

## 5. Amit a mérések mondanak (hogy ne kelljen újrafuttatni)

- **Kód-ciklus AI nélkül**, 208 nap: +2.31% (buy & hold BTC ugyanott +15.3%).
- **Kockázat-létra**, ~14 hónap két rezsimmel: a mai beállítás +4.6%, L2 +6.5%, L3 −0.9%,
  a legagresszívebb L5 −24.3%, buy & hold BTC −32.8%. A bot minden lépcsőn veri a
  buy & holdot a TELJES cikluson, mert lefelé kevesebbet veszít.
- **320 dolláron a realisztikus havi várakozás 1-5 dollár** (0.3-1.5%), és a minimum
  kötésérték a tervezett kötések egy részét kis tőkén végre sem hajthatóvá teszi.
- **Fizetős LLM-nél a havi 11-20 dollár költség nagyobb lenne, mint a teljes várható hozam.**

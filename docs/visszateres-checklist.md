# Visszatérési checklist — 2026-09-06

Ez a lap egyetlen kérdésre válaszol: **mi történt, amíg nem voltál gépnél, és működik-e a bot?**
Az állapot 2026-09-06 09:50 UTC (11:50 helyi) szerinti. Minden alábbi parancs bármelyik gépről fut.

## 1. Mi változott ebben a menetben

| commit | mit javít |
|---|---|
| `cc414da` | a dashboard client-side exception-je: az UI a T20 előtti outcome-mezőneveket olvasta |
| `03fbfb3` | a néma adatforrás-hiba: a collector hibája `ok: true, points: 0`-ként jelent meg |
| `db25e77` | a Binance HTTP 451: a Vercel függvények Frankfurtba (`fra1`) kerültek |

Részletek: a régió-döntés indoklása a `worker-runbook.md` 5. szakaszában, a hiba-lánc a
commit-üzenetekben.

## 2. Amit meg kell nézni — sorrendben

### a) Fut-e egyáltalán a külső ütemező

Ez a menet legfontosabb nyitott kérdése. A `tick_runs` táblában távozáskor **két rekord volt,
mindkettő kézi trigger** (08:45 és 09:02 UTC). Ez nem bizonyítja, hogy a cron áll — a 09:07-es
hívást a 09:02-es tick lease-e szabályosan kihagyta volna —, de azt sem, hogy megy.

```bash
curl -s "https://trade-beryl-six.vercel.app/api/ticks?limit=10" \
  | python -c "import sys,json;[print(t['ts'], t['tickId']) for t in json.load(sys.stdin)['ticks']]"
```

- **Van 10:07 UTC körüli (vagy későbbi, óránkénti :07-es) rekord** → a külső cron fut, ez a kérdés le van zárva.
- **Csak a két kézi rekord van** → a cron-job.org feladat nem fut. Ellenőrizd a szolgáltatónál:
  URL `https://trade-beryl-six.vercel.app/api/cron/tick`, `POST`, `Authorization: Bearer $CRON_SECRET`,
  ütemezés `7 * * * *` (UTC). A részletek a `worker-runbook.md` 4. szakaszában.

### b) Megjöttek-e a gyertyák (a 451 javításának tick-szintű igazolása)

```bash
curl -s "https://trade-beryl-six.vercel.app/api/ticks?limit=1" | python -c "
import sys, json
h = json.load(sys.stdin)['ticks'][0]['process']['health']
print('gyertyák:', {k: f\"{v['bars']}/{v['requiredBars']}\" for k, v in h['signals'].items()})
print('források:', [(c['name'], c['ok'], c['points'], c['error']) for c in h['collectors']])
"
```

Elvárt: **`72/48` mindhárom coinra** és `binance ok=True, points=216`.

Ha még mindig `0/48` és `HTTP 451` jön, a régióváltás nem érvényesült: nézd meg a Vercel
projekt beállításaiban, hogy a Functions régió tényleg `fra1` (Frankfurt), mert a projekt-szintű
beállítás felülírhatja a `vercel.json`-t.

Ugyanez tick nélkül, bármikor:

```bash
curl -s https://trade-beryl-six.vercel.app/api/market \
  | python -c "import sys,json;print(json.load(sys.stdin)['sources'])"
```

### c) Az első pontozott döntés

Egy döntés a horizont (1 óra) letelte után kap `outcome`-ot. Ez az első alkalom, hogy az
ÚJ DecisionCard-renderelés éles adaton fut.

```bash
curl -s "https://trade-beryl-six.vercel.app/api/decisions?limit=5" | python -c "
import sys, json
for d in json.load(sys.stdin)['decisions']:
    print(d['ts'], d['action'], '→', d['outcome'])
"
```

A dashboardon a döntés-kártya alján ekkor `✓ eltalálta az irányt` / `✗ nem találta el` vagy
`nem pontozható — <ok>` jelenik meg, `kiértékelés ~1h múlva…` helyett. Ha ott bármi hiba
látszik, a szerződés-tesztek a `tests/components/perf-contract.test.ts`-ben vannak.

### d) A dashboard nem dobhat client-side exceptiont

Nyisd meg a `https://trade-beryl-six.vercel.app/` oldalt. Ha újra „Application error"-t írna,
a böngésző konzoljában a komponens és a mező neve azonnal látszik — a mostani hiba is így volt
megfogható 5 perc alatt.

## 3. Nyitott tételek

| tétel | állapot |
|---|---|
| ML-karantén | **marad, szándékosan.** Az újratanított jelölt test AUC-je 0.524 (< 0.53 küszöb), ezért nem léptethető. A jelölt: `src/lib/ml/model.candidate.json`. Feloldás csak jobb feature-készlettel, nem a küszöb átállításával. |
| külső cron igazolása | lásd 2/a |
| gyertya-lánc tick-szintű igazolása | lásd 2/b (az adat maga hézagmentes: 72/48, 0 rés) |
| régió-visszaesés kockázata | ha a Functions bármikor visszakerül USA-ba, a Binance újra 451-et ad, és a bot némán csak HOLD-ol |

## 4. Kézi tick indítása

A lease óránkénti sávot foglal, tehát egy órán belül a második trigger `lease_held` miatt
kimarad — ez nem hiba.

```bash
SECRET=$(grep -m1 '^CRON_SECRET=' .env.local | cut -d= -f2- | tr -d '"\r')
curl -s -X POST https://trade-beryl-six.vercel.app/api/cron/tick \
  -H "Authorization: Bearer $SECRET" -w "\n%{http_code}\n"
```

A `202 {"ok":true,"accepted":true}` csak annyit jelent, hogy a ciklus elindult a háttérben;
az eredményt a `/api/ticks` mutatja meg kb. egy perccel később. A `.env`-ben lévő `CRON_SECRET`
ÜRES, a valódi titok a `.env.local`-ban van.

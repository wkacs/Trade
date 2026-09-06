# ML modell — TS-natív tréning + inferencia

A modell **a meglévő Node/TS stack-ben** tanul és fut (nincs Python/natív dep),
így a Vercel serverless bundle-be kerül, és end-to-end verifikálható.

## Áttekintés

- **Modell:** logisztikus regresszió a `next-hour up` irányra.
- **Feature-ök** (a produkciós `buildFeatures`-ből, hogy tréning=inferencia konzisztens legyen):
  `return1h`, `return4h`, `volatility4h`, `volumeRatio`.
- **Tréning-adat:** Binance ingyenes történelmi gyertyák (~5000 óra/coin), 24-gyertyás
  ablakkal — ugyanannyi, mint amit a `BinanceOHLCCollector` élesben gyűjt.
- **Artifact:** `src/lib/ml/model.json` (súlyok + feature mean/std + metrikák) — a repóban,
  bundle-elve. A `predictor.ts` ezt tölti be; ha hiányzik, naiv heurisztikára esik vissza.

## Tréning (újratanítás)

```bash
pnpm tsx scripts/train-model.ts
```
Letölti a Binance-történelmet, a `buildFeatures`-szel feature-t épít, idő-alapú
train/test splittel tanít (a teszt a legfrissebb 20% = valódi out-of-sample),
és kiírja az `src/lib/ml/model.json`-t + a metrikákat. Utána commit + push → a Vercel
auto-deploy felviszi az új modellt.

## Reális elvárás

Az intraday kripto-irány előrejelzése **nagyon nehéz**. Az első modell tipikusan
**~52–53% out-of-sample pontosság** (AUC ~0.54) — **gyenge, de valódi** jel a véletlen
felett. A modell egy **mean-reversion**-jellegű mintát tanult (magas friss return →
inkább lefelé). A fő döntéshozó továbbra is a GLM; az ML-jel egy input a sok közül.

## Továbbfejlesztés (később)

- Több feature (RSI, momentum több ablakon, order-book jelek).
- Több coin / hosszabb történelem.
- Gradiens-boosted modell (LightGBM Pythonban + JSON tree-walk inferencia), ha a
  logisztikus plafont elérte — de csak ha a backteszt indokolja.
- Mark-to-market napi P&L (a circuit breakerhez) aktuális árral.

## f3 (2026-09-06): áron kívüli kontextus — és a mérés eredménye

A f2 készlet mind a négy jellemzője ugyanabból az árfolyamsorból származott
(`return1h`, `return4h`, `volatility4h`, `volumeRatio`), out-of-sample AUC 0.524.
A hipotézis az volt, hogy ortogonális bemenet segít. Ezért a f3 két új jellemzőt kapott:

- `fundingRatePct` — finanszírozási ráta (Binance USDT-M futures, 8 óránként publikálva,
  óránkénti sorozattá az utolsó érvényes érték tartásával)
- `premiumPct` — Coinbase (USD) vs Binance (USDT) árkülönbség

Tanítás 3 coinon, 4987-4987 mintán (a kontextus hiánya miatt mindössze 7 óra maradt ki):

```
TRAIN: acc 52.3%  auc 0.535
TEST : acc 51.8%  auc 0.526   (a legfrissebb 20%)
```

**A jelölt NEM léptethető**: a teszt AUC 0.526 a 0.53-as kapu alatt maradt. A f2-höz
képest a javulás 0.524 → 0.526, azaz gyakorlatilag semmi.

Amit ez jelent — és amit NEM jelent:

- A „kevés az adat" hipotézis erre a két jellemzőre **megdőlt**. Nem az hiányzott.
- A funding 8 órás felbontású, tehát órás skálán szinte állandó; a prémium pedig
  órás bontásban apró és zajos. Mindkettő inkább lassú rezsim-változó.
- A REAKTÍV mutatók (nyitott pozíció változása, taker-flow) nem kerülhettek a tanításba,
  mert a Binance ezekből csak ~21-30 napot ad vissza. Ezek élő döntési kontextusként
  mennek a phase-1/phase-2 promptba.

Következő lépés, ha ezt tovább akarjuk vinni: a tick MENTSE az élő derivatíva-adatot,
és néhány hónap múlva saját történetből tanítható a reaktív készlet. Vásárolni nem kell
hozzá semmit, csak időt.

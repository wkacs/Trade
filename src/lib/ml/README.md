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

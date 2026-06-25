# ML modell tréning (külső Python script)

A LightGBM modell tréningét **külön Python környezetben** végezzük,
a `raw_events` táblából kinyert történelmi adatokon. A betanított modellt
JSON/ONNX formátumban mentjük, és a Vercel Blob Storage-ba töltjük.

## Állapot

**Demo-fázis:** a `predictor.ts` jelenleg naiv heurisztikát használ:
- pozitív 1h return + alacsony volatilitás → `"up"`
- erősen negatív return → `"down"`
- egyébként → `"flat"`

Ez elegendő az AI döntési lánc végpontoktól végpontig történő teszteléséhez.
A valódi LightGBM modell csak a demo-fázis után jön, amikor már van elég
történelmi adat a `raw_events` táblában.

## Lépések (a demo-fázis után)

1. **Adatexport** — a `raw_events` táblából CoinGecko ár-történet:
   ```bash
   pnpm tsx scripts/export-raw-events.ts > ml_training_data.json
   ```

2. **Tréning Pythonnal:**
   ```python
   import lightgbm as lgb
   import json

   data = json.load(open("ml_training_data.json"))
   # Feature-ök + címkék (1 órás forward return iránya) felépítése
   # X_train, y_train, ...

   params = {"objective": "binary", "metric": "auc", "verbosity": -1}
   train_data = lgb.Dataset(X_train, label=y_train)
   bst = lgb.train(params, train_data, num_rounds=100)
   bst.save_model("model.json")
   ```

3. **Feltöltés** — a `model.json`-t töltsd fel a Vercel Blob Storage-ba,
   és állítsd be a `ML_MODEL_URL` env-et.

4. **Inferencia** — a `predictor.ts` implementálja a tree-walk-ot a JSON-ből,
   vagy használjon ONNX runtime-ot.

## Miért külön Python?

- A Vercel szerverless környezet nehezen futtat natív LightGBM C++ kódot.
- A tréning ritka (heti/havi), nem kell a web appban élnie.
- A súlyok (artifact) elég, ha a prediction idején elérhetők.

Lásd még: `docs/superpowers/specs/2026-06-25-ai-crypto-trader-design.md` §3.2.

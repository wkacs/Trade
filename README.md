# AI Kereskedő Bot

Személyes használatú web app: egy **hibrid AI** (LightGBM + GLM) óránkénti
döntésekkel menedzsel egy kripto-portfóliót (**BTC, ETH, SOL**), **látható
érveléssel**. Demo (papír-trading) módban indul, konfigurálhatóan váltható
valós Binance módra a demo validálása után.

> **Cél:** nem a „biztos profit", hanem egy olyan rendszer, ahol minden döntés
> mögött **látható és visszamenőleg vizsgálható**, hogy az AI milyen adatokra
> és érvekre támaszkodott.

## Architektúra

```
Vercel Cron (óránként) → /api/cron/tick
   → Data Collectors (CoinGecko, CryptoPanic, WhaleAlert, RSS)
   → ML feature + predict (LightGBM / naiv heurisztika)
   → Phase-1 LLM (GLM-4-Flash): „érdemes-e dönteni?"
   → Phase-2 LLM (GLM-5.2): strukturált döntés + érvelés
   → Risk Manager (konzervatív limitek)
   → Execution (PaperBroker / BinanceBroker)
   → Neon Postgres: minden döntés + érvelés idősorozatként
```

Részletes spec: [`docs/superpowers/specs/2026-06-25-ai-crypto-trader-design.md`](docs/superpowers/specs/2026-06-25-ai-crypto-trader-design.md)
Implementációs terv: [`docs/superpowers/plans/2026-06-25-ai-crypto-trader.md`](docs/superpowers/plans/2026-06-25-ai-crypto-trader.md)

## Kockázati limitek (konzervatív, hardcoded)

| Szabály | Érték |
|---|---|
| Max pozíció / tőke | 20% |
| Stop-loss (kötelező) | -5% |
| Leverage | 1× (nincs tőkeáttétel) |
| Max egyidejű pozíció | 3 |
| Napi circuit breaker | -3% után csak HOLD |

## Setup

### 1. Függőségek telepítése
```bash
pnpm install
```

### 2. Neon Postgres adatbázis
1. Hozz létre egy Neon projektet: https://neon.tech (ingyenes tier)
2. Másold a connection string-et a `.env.local`-be (lásd `.env.example`)

### 3. GLM API kulcs (Zhipu AI)
1. Regisztrálj: https://open.bigmodel.cn
2. Készíts API kulcsot
3. Állítsd be a `.env.local`-ben:
   ```
   LLM_API_KEY=...
   LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
   LLM_MODEL_PHASE1=glm-4-flash   # ingyenes, gyakori szűrés
   LLM_MODEL_PHASE2=glm-5.2        # ritka, komoly döntések
   ```

### 4. Adatbázis migráció
```bash
pnpm db:generate
pnpm db:migrate
```

### 5. (Opcionális) Hír/whale API kulcsok
```
CRYPTOPANIC_TOKEN=...
WHALEALERT_KEY=...
```
Ezek nélkül is fut a rendszer (CoinGecko árak mindig jönnek).

### 6. Futtatás
```bash
pnpm dev
```
Nyisd meg: http://localhost:3000

### 7. Cron tick manuális indítása (teszteléshez)
```bash
curl -X POST http://localhost:3000/api/cron/tick
```
Ha `CRON_SECRET` be van állítva:
```bash
curl -X POST http://localhost:3000/api/cron/tick -H "Authorization: Bearer $CRON_SECRET"
```

## Vercel deploy

1. Pushold a repót GitHubra
2. Importáld a Vercelbe
3. Állítsd be az env változókat a Vercel dashboard-on
4. A `vercel.json`-ben definiált cron óránként (`0 * * * *`) lefut

## Biztonság

- **`TRADING_MODE=paper`** az alapértelmezett — sose indulj live nélkül validálás nélkül
- Binance kulcs csak `read + trade` jogosultság, **SOHA withdraw**
- A kockázati limiteket a Risk Manager **minden** tranzakciónál érvényesíti,
  függetlenül attól, mit javasol az AI
- API kulcsok csak Vercel env-ben, **soha** nem commitolva

## Tesztelés
```bash
pnpm test          # egyszeri futtatás
pnpm test:watch    # watch mód
pnpm exec tsc --noEmit   # típusellenőrzés
pnpm build         # Next.js production build
```

## ML modell tréning

Lásd: [`src/lib/ml/README.md`](src/lib/ml/README.md) — külön Python környezet,
a demo-fázis után. Amíg a LightGBM nincs betanítva, a predictor naiv
heurisztikát használ (elég az AI lánc teszteléséhez).

## Tech Stack

- **Next.js 14** (App Router, TypeScript) + **Tailwind CSS**
- **Neon Postgres** + **Drizzle ORM**
- **Vercel Cron** + serverless API routes
- **GLM API** (OpenAI-compatible, Zhipu AI)
- **Vitest** (TDD)
- (később) **LightGBM** külön Python tréninggel

## Státusz

- ✅ Teljes rendszer implementálva, demo (paper) módban futtatható
- ⏳ ML modell betanítása — a demo-fázis után (miután gyűlt történelmi adat)
- ⏳ BinanceBroker valós implementációja — a demo validálása után (2. fázis)

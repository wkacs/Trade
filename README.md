# AI Kereskedő Bot

Személyes használatú web app: egy **hibrid AI** (ML-jel + GLM) óránkénti döntésekkel
menedzsel egy kripto-portfóliót (**BTC, ETH, SOL**), **látható érveléssel**.

**Jelenlegi státusz: paper (demó) mód. Live kereskedés kikapcsolva.**

> **Cél:** nem a „biztos profit", hanem egy olyan rendszer, ahol minden döntés mögött
> **látható és visszamenőleg vizsgálható**, hogy az AI milyen adatokra és érvekre
> támaszkodott.

---

## Mi fut ma, pontosan

| Kérdés | Válasz |
|---|---|
| Kereskedési mód | **paper** (`TRADING_MODE=paper`). Live nincs verifikálva, nincs bekapcsolva. |
| Ütemező | **pontosan egy** a `SCHEDULER` szerint. Alap: `github-actions` (óránként :07). |
| Belépés | óránként, **lezárt** gyertyán |
| Kilépés (stop / TP / trailing) | 5 percenként — **csak `SCHEDULER=worker` esetén.** GitHub-ütemezéssel óránként. |
| Phase-1 LLM | `glm-4.7-flash` (ingyenes) — „érdemes-e most dönteni?" |
| Phase-2 LLM | `glm-5.2` (**fizetős**, egyenleg kell) — strukturált döntés + érvelés |
| ML-jel | logisztikus regresszió (`src/lib/ml/model.json`). **A modell karanténban van**, amíg nincs újratanítva a `f2-2026-09-05` feature-verzióra. Karanténban nincs ML-jel; a rendszer LLM + kód-alapú szabályokkal fut. |
| Stratégia-verzió | `v2-2026-09-05` (minden intent és fill hordozza) |

Az ütemezés, indítás, leállítás, health és rollback részletei:
**[`docs/worker-runbook.md`](docs/worker-runbook.md)**.

---

## Architektúra

```
Ütemező (worker VAGY GitHub Actions VAGY Vercel HTTP-cron)
   → LEASE az idősávra (egy író, fencing token)
   → Piaci adat: LEZÁRT órás gyertyák + KÜLÖN friss bid/ask (max 10s)
   → Data Collectors (CoinGecko, RSS, Fear&Greed, opcionálisan CryptoPanic/WhaleAlert/Reddit)
   → ML feature + predict (verzió-kötött; eltérésnél KARANTÉN)
   → Phase-1 LLM: „érdemes-e dönteni?"
   → Phase-2 LLM: strukturált döntés + érvelés
   → Risk Manager (mértékadó decimális kapu: fedezet, headroom, min notional)
   → Execution (paper fill-szimuláció / Binance, tőzsdei szűrőkkel)
   → Ledger (BigInt fixpontos könyvelés, ATOMI mentés SQL-függvényben)
```

Külön, 5 perces **kilépés-ciklus** fut (LLM nélkül): stop, take-profit, trailing.
Ez sosem vár az LLM-re — külön hurok, külön lease.

Specifikációk: [`docs/superpowers/specs/`](docs/superpowers/specs/) ·
Ledger-szerződés: [`docs/ledger-contract.md`](docs/ledger-contract.md) ·
Audit: [`docs/2026-09-05-profit-audit.md`](docs/2026-09-05-profit-audit.md)

---

## Kockázati limitek

Egy forrásból (`DEFAULT_STRATEGY`) származnak, a Risk Manager **minden** tranzakciónál
érvényesíti őket, függetlenül attól, mit javasol az AI.

| Szabály | Érték |
|---|---|
| Max pozíció / tőke | 20% |
| Stop-loss (kötelező) | −5% |
| Take-profit | +10%, teljes pozíció |
| Trend-szűrő belépésre | be (24 órás SMA) |
| DCA | Fear&Greed ≤ 20, 2% vásárlás, heti keret a tőke 5%-a |
| Leverage | 1× (nincs tőkeáttétel) |
| Max egyidejű pozíció | 3 |
| **Napi** circuit breaker | −3% a NAP nyitóértékéhez képest → csak HOLD |

A napi kapu a **nap eleji tőkéhez** mér, nem az induló tőkéhez. (A régi kód az
indulás óta számolt, ezért egy nyereséges hónap után gyakorlatilag sosem aktivált —
lásd az auditot.)

---

## Setup

### 1. Függőségek
```bash
pnpm install
```

### 2. Neon Postgres
1. Hozz létre egy Neon projektet: https://neon.tech (ingyenes tier)
2. Másold a connection stringet a `.env.local`-be (minta: `.env.example`)

### 3. GLM API kulcs (Zhipu AI)
1. Regisztrálj: https://open.bigmodel.cn
2. Készíts API kulcsot
3. `.env.local`:
   ```
   LLM_API_KEY=...
   LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
   LLM_MODEL_PHASE1=glm-4.7-flash   # ingyenes, gyakori szűrés
   LLM_MODEL_PHASE2=glm-5.2         # fizetős, ritka, komoly döntések
   ```

### 4. Adatbázis migráció
```bash
pnpm db:generate
pnpm db:migrate
```

### 5. Ütemező kiválasztása (KÖTELEZŐ döntés)
```
SCHEDULER=github-actions   # óránkénti tick, nincs 5 perces kilépés
# vagy
SCHEDULER=worker           # állandó folyamat, teljes működés
```
Egyszerre **egy** lehet aktív; a másik magától kihagyja magát. Lásd a runbookot.

### 6. Futtatás
```bash
pnpm dev                     # dashboard: http://localhost:3000
pnpm worker                  # állandó worker (SCHEDULER=worker esetén)
pnpm worker:once             # EGY kilépés-ciklus
pnpm tsx scripts/tick.ts     # EGY belépés-ciklus (runner-oldal)
```

### 7. Tick kézi indítása HTTP-n
```bash
curl -X POST http://localhost:3000/api/cron/tick -H "Authorization: Bearer $CRON_SECRET"
```
`CRON_SECRET` nélkül az endpoint **elutasít** (fail-closed).

---

## Vercel deploy

A Vercel a dashboardot és a hitelesített `POST /api/cron/tick` kereskedési ciklust is
futtatja. A projektben Fluid Compute aktív, ezért a route időkorlátja 300 másodperc.
A `vercel.json`-ben nincs natív cron, mert a Hobby csomag csak napi egy cronfutást
enged; órás futáshoz külső HTTP-időzítő (például QStash) hívja a production URL-t.

1. Pushold a repót GitHubra
2. Importáld a Vercelbe
3. Állítsd be az env változókat a Vercel dashboardon (a `CRON_SECRET`-et is)

---

## Biztonság

- **`TRADING_MODE=paper`** az alapértelmezett — live-ra váltás csak külön döntéssel
- Binance kulcs csak `read + trade`, **SOHA withdraw**
- A `/api/cron/tick` **fail-closed**: `CRON_SECRET` nélkül nem fut le
- API kulcsok csak env-ben, **soha** nem commitolva

---

## Tesztelés

```bash
pnpm test                # unit + logikai tesztek
pnpm test:integration    # valódi PostgreSQL kell hozzá (TEST_DATABASE_URL)
pnpm exec tsc --noEmit   # típusellenőrzés
pnpm build               # Next.js production build
```

Backteszt és kísérletek:
```bash
pnpm tsx scripts/backtest.ts
pnpm tsx scripts/tournament.ts
```

---

## ML modell

A predictor **verzióhoz kötött**: ha a `model.json` feature-verziója nem egyezik a
futó kódéval, a modell **karanténba kerül**, és nincs ML-jel (nem „úgy csináljuk,
mintha" jóslunk). Újratanítás: `pnpm tsx scripts/train-model.ts`, majd a
promóciós kapun kell átmennie — a puszta „AUC ≥ 0.5" nem elég.

Részletek: [`src/lib/ml/README.md`](src/lib/ml/README.md).

---

## Tech Stack

- **Next.js 14** (App Router, TypeScript) + **Tailwind CSS**
- **Neon Postgres** + **Drizzle ORM** (a könyvelés atomicitása PL/pgSQL függvényben,
  mert a `neon-http` driver nem tud interaktív tranzakciót)
- **GLM API** (OpenAI-compatible, Zhipu AI)
- **Vitest** (TDD)
- Ütemezés: állandó Node worker, GitHub Actions vagy a Vercel route-ot hívó HTTP-cron

---

## Státusz és korlátok

- ✅ Az audit (`docs/2026-09-05-profit-audit.md`) hibái javítva, regressziós tesztekkel
- ✅ Paper módban futtatható, minden döntés és könyvelés visszavezethető
- ⏳ ML modell újratanítása a v2 feature-készletre (addig karantén)
- ⏳ Integrációs tesztek: megírva, de valódi PostgreSQL nélkül **nem futottak le**
- ⛔ Live kereskedés: **nincs verifikálva, nincs bekapcsolva.** Előfeltételek:
  [`docs/verification/profit-fixes.md`](docs/verification/profit-fixes.md)

# AI Kereskedő Bot Web App — Design Spec

- **Dátum:** 2026-06-25
- **Státusz:** Approved (brainstorming befejezve)
- **Szerző:** együttműködés a felhasználóval (brainstorming)
- **Következő lépés:** implementation plan (writing-plans skill)

---

## 1. Áttekintés és cél

Egy **személyes használatú** web app, amelyben egy **hibrid AI** önállóan menedzsel egy kripto-portfóliót (kezdőtőke: 10 000 Ft, fokozatosan növelhető). Az ML objektív piaci jeleket ad (ár-/volatilitás-előrejelzés), a GLM LLM kontextualizál: elolvassa a híreket és whale-mozgásokat, érvel, és **látható indoklással** hoz döntést.

**A projekt célja nem a „biztos profit".** A cél egy olyan rendszer, ahol minden döntés mögött **látható és visszamenőleg vizsgálható**, hogy az AI milyen adatokra és érvekre támaszkodott. A kezdőtőke csak akkor növelendő, ha a demo-fázis meggyőző.

**Működési mód:** a rendszer **demo módban (papír-trading) indul** — szimulált egyenleg, valós piaci adatokkal. Egy konfig kapcsolóval váltható valós módra (Binance Spot API), miután a demo validálva lett.

### Kulcsfontosságú döntések (a brainstormingból)

| Döntés | Érték | Indoklás |
|---|---|---|
| Piac | Kriptovaluták | Legstrukturáltabb hírek/whale-adatok, 24/7, reális kis tőkéhez |
| Kereskedés módja | Demo először, utána valós | Legbiztonságosabb, fokozatos |
| AI típusa | Hibrid (ML + LLM) | ML objektív számítás, LLM kontextus + érvelés |
| Időhorizont | Intraday (óránkénti ciklus) | Jól illik a hibrid modellhez |
| Stack | Vercel + Neon Postgres | Modern, ingyenes tier, személyes használat |
| LLM | GLM-4-Flash (gyakran) + GLM-5.2 (ritkán) | 2-fázisos design → GLM-5.2 usage limitlek alatt |
| Megközelítés | B) Teljes rendszer (de demo módban indul) | Teljes funkcionalitás, de a demo→valós kapcsoló konfigban |
| Kockázat | Konzervatív | Védi a kis tőkét |

---

## 2. Architektúra — magas szint

```
┌─────────────────────────────────────────────────────────────┐
│                        VERCEL (Next.js)                       │
│  ┌───────────────┐    ┌──────────────────────────────────┐  │
│  │   Frontend     │◄──►│   API Routes (backend)            │  │
│  │  React + Tail  │    │  • /api/cron/tick (óránként)      │  │
│  │  Dashboard:    │    │  • /api/portfolio                │  │
│  │  - egyenleg    │    │  • /api/decisions (history)      │  │
│  │  - pozíciók    │    │  • /api/backtest                 │  │
│  │  - döntések +  │    │  • /api/admin (mode switch)      │  │
│  │    érvelések   │    └─────────────┬────────────────────┘  │
│  │  - P&L graf.   │                  │                         │
│  └───────────────┘                  ▼                         │
│                          ┌──────────────────────┐            │
│  Vercel Cron ─óránként──►│  Trading Engine      │            │
│                          │  (a rendszer "agya")  │            │
│                          └──┬─────┬─────┬───────┘            │
└─────────────────────────────┼─────┼─────┼─────────────────────┘
                              │     │     │
              ┌───────────────┘     │     └────────────────┐
              ▼                     ▼                      ▼
   ┌──────────────────┐  ┌──────────────────┐   ┌──────────────────┐
   │ Data Collectors  │  │  AI Decision Core│   │  Execution Layer │
   │ (plug-in modulok)│  │  ML + LLM hibrid │   │  paper / binance │
   └──────────────────┘  └──────────────────┘   └──────────────────┘
          │  │  │              │   ▲                    │   │
          │  │  │              │   │                    │   │
          ▼  ▼  ▼              ▼   │                    ▼   │
  CryptoPanic WhaleAlert  CoinGecko  NEON POSTGRES  ◄──┘   │
  (hírek)    (whale)      (ár)      (az egyetlen       Binance API
  + legális               ──────────  igazságforrás)   (valós mód)
   RSS scrape-ek           minden adat idősorozatként
```

### Kulcselvevek

- **Vercel Cron** indítja óránként a `/api/cron/tick` route-ot — ez az egyetlen „szívverés". Nem kell állandóan futó process.
- **Neon Postgres** az egyetlen igazságforrás: minden — döntések, tranzakciók, pozíciók, P&L, de még a hírek pillanatképe is — idősorozatként tárolva. Ez teszi lehetővé a backtest-et és a „miért döntött így" vissza-követést.
- **Demo/valós mód** ugyanazon a kódon: csak az *Execution Layer* cserélődik (`PaperBroker` ↔ `BinanceBroker`), egyetlen env/config kapcsolóval.

---

## 3. Komponensek

### 3.1 Data Collectors (adatgyűjtők — plug-in szerűek)

Minden gyűjtő egy közös interfészt valósít meg: `collect(): Promise<DataPoint[]>`. Így új forrás hozzáadása egyetlen új fájl.

| Gyűjtő | Mit ad | Ingyenes tier |
|---|---|---|
| `CryptoPanicCollector` | Hírek + sentiment score (bullish/bearish) | ✅ ingyenes API |
| `WhaleAlertCollector` | Nagy on-chain tranzakciók (>500k USD) iránnyal | ✅ ingyenes |
| `CoinGeckoCollector` | Árfolyamok, volume, market cap, 24h change | ✅ ingyenes |
| `RSSCollector` | Legális RSS források (pl. CoinDesk) — csak ToS-t engedő oldalak | ✅ |

**Bővíthetőség:** később `GlassnodeCollector`, `SantimentCollector` is hozzáadható ugyanezen az interfészen.

### 3.2 AI Decision Core (hibrid — a rendszer „agya")

Két fázis, hogy a GLM-5.2 limitjeit ne feszítsük túl:

**Fázis 1 — „Szűrés" (GLM-4-Flash, ingyenes, minden órában):**
A gyűjtők adatait összegezve olvassa: *„Van-e valami érdemes a döntésre?"* Ha semmi új / semmi szignifikáns → **HOLD**, mentés, vége. Ez a 90%-a az óráknak.

**Fázis 2 — „Döntés" (GLM-5.2, csak ha az 1. fázis jelez):**
Strukturált bemenet (JSON): ML-jelek, top hírek sentimenttel, whale-mozgások összegzése, jelenlegi portfólió, kockázati limitlek. Kimenet **szigorú JSON-séma**: `{action, symbol, amountPct, confidence, reasoning}`. A `reasoning` kötelező — ez az érvelés, amit a UI-ban megmutatunk.

**ML komponens (az LLM mellett, nem helyette):**
Egy egyszerű, helyileg betanított **LightGBM** modell (választás: LightGBM gyorsabb tanít és könnyebb telepíteni Pythonban, mint XGBoost; kisebb csomagfüggőség). Célja ár- és volume-előrejelzés (pl. 1/4/24 órás várható irány + volatilitás). Ez csak egy újabb „vélemény" a LLM asztalán, nem végrehajtó. A tréning a múltbeli `raw_events` adatokon történik; a betanított modell artifact a Vercel Blob Storage-ban tárolva (a repo-ban nem — a blob okozna merge-konfliktusokat és felfújná a git history-t).

### 3.3 Execution Layer (végrehajtás — cserélhető demo/valós)

Közös interfész: `execute(order): Promise<Trade>`.

- **`PaperBroker`** (demo, alapértelmezett): szimulált egyenleg, valós áron (CoinGecko ár) „futtatja" az order-t. Stop-loss és limitlek itt is érvényesülnek.
- **`BinanceBroker`** (valós, 2. fázis): Binance Spot API, read+trade kulccsal. **A kockázati limitlek itt is kötelezőek** — a broker elutasítja a limitleken kívüli order-eket, függetlenül az AI döntésétől.

### 3.4 Risk Manager (kockázatkezelő — konzervatív)

**Minden order kötelezően átmegy rajta**, az AI döntése felett:

| Szabály | Érték |
|---|---|
| Max pozíció / tőke | 20% |
| Stop-loss (kötelező) | -5% |
| Leverage | 1x (nincs tőkeáttétel) |
| Max egyidejű pozíció | 3 |
| Napi max veszteség (circuit breaker) | -3% (ha eléri, aznap HOLD-only) |

Ha az AI olyat javasol, ami ezeket átlépi → **a Risk Manager módosítja vagy elutasítja**, és ezt is naplózzuk (a `risk_overrides` táblába), így látható, mikor „akart az AI többet".

### 3.5 Frontend (React + Tailwind dashboard)

Egy oldal, **nagy fókusz a döntés-érthetőségen** (mert ez a projekt lényege):

- **Főpanel:** jelenlegi egyenleg, P&L (mai / total %), aktív pozíciók kártyái.
- **Döntések idővonala:** kártyák, mindegyiknél látszik — *idő, action, confidence %, és a teljes érvelés szövege*. Ez a „saját vélemény".
- **„Miért döntött így?"** részletnézet: bemeneti adatok pillanatképe (mely hírek, mely whale-mozgások vezérelték).
- **Backtest fül:** futtass egy stratégiát múltbeli adatokon, lásd a P&L-t.
- **Admin:** demo↔valós mód kapcsoló (kettős megerősítéssel), GLM API kulcs státusz, limithasználat.

### 3.6 Coin kosár (fix, később bővíthető)

Kezdetben **fix kosár**: `BTC, ETH, SOL` (USDT párban). Az AI csak ezek között kereskedhet. Indoklás: a leglikvidebb, legkevésbé manipulálható coinok, megfelelő a kis tőkéhez, elegendő hír/whale-adat érkezik róluk. Később a `settings.coin_universe` konfig módosításával bővíthető.

---

## 4. Adatfolyam — egy „óra" élete

1. **Vercel Cron** (óránként) → `POST /api/cron/tick`.
2. **Data Collectors** lefutnak → nyers adatok a Postgres-be (`raw_events`, idősorozat).
3. **ML modell** friss jeleket számol a friss árakon → `ml_signals`.
4. **Fázis-1 LLM** (GLM-4-Flash) átolvassa az új eseményeket → *érdemes-e dönteni?*
   - Ha NEM → `HOLD` döntés mentése érveléssel, vége.
   - Ha IGEN → Fázis-2.
5. **Fázis-2 LLM** (GLM-5.2) teljes kontextussal → strukturált döntés + érvelés.
6. **Risk Manager** validálja/módosítja.
7. **Execution Layer** (paper vagy binance) végrehajt.
8. **Mindent** a Postgres-be mentünk: döntés, érvelés, tranzakció, új pozíció-állapot, P&L.

---

## 5. Adatmodell (Postgres / Neon) — vázlat

```
portfolios        egy portfólió (kezdőtőke, mód: paper/live, egyenleg)
positions         nyitott pozíciók (symbol, qty, entry, stop, opened_at)
trades            végrehajtott tranzakciók (több egy pozícióhoz)
decisions         AI döntések: action, confidence, reasoning, model, ts
ml_signals        ML jelek időpontonként (per coin)
raw_events        gyűjtők nyers adatai (hírek, whale, ár) — idősorozat
risk_overrides    amikor a Risk Manager módosított/elutasított
backtests         backtest futtatások eredménye
settings          globális config (mode, limitlek, api kulcsok ref, coin kosár)
```

Minden idősorozat-szerű — ez teszi lehetővé a *„miért döntött így az AI 3 hete?"* vizsgálatot.

---

## 6. Hibakezelés, biztonság, kockázatok

- **API kulcsok titkosak** — Vercel environment variables, **soha** nem a Postgres-ben plaintext-ben.
- **Broker kulcs (valós mód):** csak `read + trade` jogosultság, **soha withdraw**. 2. fázis, csak a demo validálása után.
- **LLM-hiba:** ha a GLM nem válaszol / timeout / sérült JSON → `HOLD` (sosem omlik össze a portfólió).
- **Circuit breaker:** napi -3% veszteség után aznap csak HOLD.
- **GLM usage limitlek:** a 2-fázisos design biztosítja, hogy a limites GLM-5.2 ritkán menjen csak. Ha mégis kimerül → automatikus visszaesés GLM-4-Flash-re, naplózás, UI-jelzés.
- **Idempotens tick:** tick azonosító alapján deduplikáció, hogy egy esetlegesen kétszer lefutó cron ne okozzon dupla tranzakciót. (Megjegyzés: Vercel Cron legfeljebb perc-pontos, és előfordulhat késett vagy dupla hívás, így a `tick_id = YYYY-MM-DD-HH` alapú guard kötelező a tick route elején.)

---

## 7. Tesztelési stratégia

- **Unit tesztek** minden komponensre (collectors, risk manager, paper broker — tiszta logika, könnyű tesztelni).
- **Integration tesztek** a `/api/cron/tick`-re mockolt adatokkal (GLM, árak, hírek mind fake-elve) — így a teljes döntési lánc determinisztikusan lefuttatható.
- **Backtest** mint első-class állampolgár: bármelyik stratégiát lehessen történelmi adatokon futtatni, mielőtt valós módba kapcsolunk.
- **Risk Manager tesztek** a legfontosabbak: explicit tesztek arra, hogy a limitleken kívüli order-eket elutasítja/módosítja.

---

## 8. Out of scope (YAGNI)

- **High-frequency / másodperces kereskedés** — intraday óránkénti marad.
- **Derivatives / futures / leverage > 1x** — csak spot, nincs tőkeáttétel.
- **Webhook-ek / push notificationök a felhasználónak** — elég a dashboard, ha valaki megnyitja.
- **Több felhasználó / auth rendszer** — személyes használat, egyetlen felhasználó.
- **Mobile app** — reszponzív web UI elég.
- **Automatikus adóbevallás / jelentések** — Magyarországon egyénileg kell kezelni, nem automatikus.

---

## 9. Nyílt kérdések (később oldandó, nem blokkoló)

- A valós módra váltás feltételei (mekkora demo-időszak, milyen P&L küszöb?) — a backtest és demo futás után közösen definiáljuk.
- ML modell pontos architektúrája és retrain gyakorisága — az első adatgyűjtés után finomhangolható.
- A coin kosár bővítése — csak ha az első három coinon a rendszer stabil.

# Observability: liveness-riasztó + realized analitika — Design

> **Cél:** (A) Ne tudjon a bot **némán** elhalni — egy dead-man's-switch riaszt, ha X órája nincs sikeres tick. (B) A **valódi (realized)** kereskedési teljesítmény láthatóvá tétele (closed-trade ledger + bontások + realized equity), hogy a jövőbeli stratégia-munka adat-alapú legyen.

**Dátum:** 2026-06-28
**Státusz:** jóváhagyott design → következő lépés: writing-plans
**Kapcsolódó:** [`2026-06-28-profit-boost-design.md`](./2026-06-28-profit-boost-design.md) (a Spec 2 worker-fast-exit ELVETVE — a „gyorsítás" nem boostol profitot; ehelyett ops-higiénia + analitika), [`2026-06-27-backtest-engine-design.md`](./2026-06-27-backtest-engine-design.md)

---

## 1. Probléma és kontextus

A felhasználó kérdése után („mi boostolná a profitot?") a mérés-alapú válasz: **a könnyű profit-emelők kimerültek** (a tournament optimalizálta a stratégiát, a 2026-06-28-i kapu a momentum/sizing/érme-emelőket elutasította; a gyors-exit Spec 2 a profitot sem boostolja egy türelmes, self-healing stratégiánál). Két **genuinely hasznos, NEM-profit** irány maradt, amit a user jóváhagyott:

- **Liveness:** a bot egyszer már **~14 órán át némán halott** volt (a régi Vercel-timeout). Most a GitHub-runneren fut, de még mindig elhalhat csendben (lejárt secret, döglött LLM-kulcs, Neon-kimaradás). A GitHub Actions **e-mailt küld, ha a workflow HIBÁZIK** (`scripts/tick.ts` nem-nulla exit), DE a **néma no-run outage**-et (a job el sem indul) nem fogja el. Pont ez a rés a veszélyes.
- **Realized analitika:** a meglévő `getPerformanceSummary` a **döntés-minőséget** méri (hipotetikus „bejött volna?" a `decisions.outcome`-ból), de a **valódi lezárt trade-ek** P&L-je, coin/exit-origin bontása és a realized equity-görbe **nincs** kimutatva — enélkül bármilyen jövőbeli profit-kutatás vak.

A `#3` (ML-jel / Approach B profit-kutatás) **szándékosan elhalasztva**: alacsony prior (a kapu hasonlót elutasított), és a `#2` analitika az **előfeltétele** annak, hogy a `#3`-at adat-alapon (ne tippből) döntsük el.

---

## 2. Hatókör

**Benne van:**
1. **Liveness — dead-man's-switch:** `pingHeartbeat()` helper + bekötés az ütemezett tickbe + user-setup doc.
2. **Realized analitika:** tiszta aggregáló modul (closed-trade ledger + bontások + realized equity) + `/api/analytics` route + `AnalyticsPanel` dashboard-komponens.

**Hatókörön kívül (YAGNI):**
- Maga a riasztás-szolgáltatás (healthchecks.io) — **külső**, a user állítja be; a kód csak pingel.
- ML-jel / Approach B profit-kutatás (`#3`) — külön, későbbi döntés a `#2` adatai alapján.
- Always-on worker / gyors-exit (Spec 2) — elvetve.
- Új értesítési csatorna-integráció a kódban (Telegram-bot stb.) — a dead-man's-switch a csatornát a külső szolgáltatáson kezeli.

---

## 3. Komponensek és változó fájlok

### 3.1 Liveness — `src/lib/ops/heartbeat.ts` (ÚJ)

A dead-man's-switch minta: a tick **sikerkor pingel** egy konfigurált URL-t; a **külső** szolgáltatás (healthchecks.io vagy hasonló) riaszt, ha a ping a grace-period alatt **nem érkezik meg** (= a bot elhallgatott). Így a CSENDET detektáljuk, nem a hibát — pont a néma outage ellen.

- **Interfész (well-bounded):** `pingHeartbeat(ok: boolean): Promise<void>` — tiszta a hívó felé, **best-effort**:
  - `HEARTBEAT_URL` env nincs → **no-op** (ha a user nem állít be semmit, semmi nem törik).
  - van → `fetch(ok ? HEARTBEAT_URL : \`${HEARTBEAT_URL}/fail\`)`; a `/fail` suffix (healthchecks.io konvenció) **azonnali** riasztást kér hiba esetén.
  - bármilyen fetch-hiba **elnyelve** (try/catch, sosem dob) — a riasztás-ping SOHA nem akaszthatja meg a ticket.
- **Bekötés — `src/lib/engine/run-scheduled-tick.ts`:**
  - a sikeres ág végén (a `return { ok: true, ... }` előtt) → `await pingHeartbeat(true)`.
  - a `catch (e)` ágban (ciklus-hiba) → `await pingHeartbeat(false)` a `return { ok: false, ... }` előtt.
  - Mindkét futtató (GitHub-runner `scripts/tick.ts` ÉS a Vercel route) ezt hívja → egy forrás, mindkét úton pingel.
- **User-setup (doc, a tervben részletezve):** healthchecks.io check létrehozása (period = 1h, grace = ~90 perc, hogy a GitHub-cron ismert hézagai NE adjanak hamis riasztást) → a ping-URL bemásolása `HEARTBEAT_URL` néven a **GitHub repo-secretek** közé + a **Vercel env**-be; a riasztás-csatorna (e-mail a user címére) a healthchecks.io-n.

### 3.2 Realized analitika — `src/lib/portfolio/analytics.ts` (ÚJ)

Tiszta-ish lekérdező/aggregáló fv-ek (DB-olvasás, de Date.now/Math.random nélkül; a tesztek injektált sorokkal mennek). A `positions` (entryPrice, openedAt, closedAt) + `trades` (positionId, side, price, qty, amountUsd, origin, executedAt) táblákból.

- `getClosedTrades(dbOverride?)` → **closed-trade ledger:** minden lezárt pozícióra (closedAt nem null) egy round-trip rekord: `{ symbol, entryPrice, exitPrice, qtyClosed, pnlUsd, pnlPct, holdHours, exitOrigin }`. Az exitOrigin a pozíció záró SELL-trade `origin`-je (stop-loss / take-profit / momentum / manual).
- `getBreakdowns(dbOverride?)` → **bontások:** win-ráta & átlag pnlPct **coinonként** és **exit-origin szerint** (stop-loss vs take-profit dominancia). Mindkettő megbízhatóan a `positions`+`trades`-ből jön. (A „F&G-belépő bucket" bontás **kihagyva** — a `decisions.ref` nem tárol strukturált F&G-t, csak árat; a belépő-F&G visszafejtése a `rawEvents` sentiment-eseményekből a pozíció `openedAt`-jéhez bizonytalan és törékeny → későbbi, opcionális bővítés, ha az adat megbízhatóan kinyerhető.)
- `getRealizedEquityCurve(dbOverride?)` → **realized equity-görbe:** kezdőtőke + a closed-trade-ek kumulált realized P&L-je az exit-időpontok mentén (egyszerű, csak realizált — a nyitott pozíciók mark-to-market a meglévő portfólió-API-ban már megvan).

**Interfész-elv:** mindegyik fv önállóan tesztelhető (a számoló mag tiszta; a DB-olvasás vékony köré). A meglévő `accounting.ts`/`evaluate.ts` mintáját követi (`dbOverride` a tesztelhetőségért, hiba → üres/biztonságos default, nem dob).

### 3.3 API + UI

- **`src/app/api/analytics/route.ts` (ÚJ):** a 3.2 három fv-ének eredménye egy JSON-ban; `export const dynamic = "force-dynamic"` + `no-store` (a `market`/`ticks` route mintára, a Neon-cache elkerülésére — lásd a 664f3ba cache-gotchát).
- **`src/components/AnalyticsPanel.tsx` (ÚJ):** a ledger (tábla), a bontások (kis kártyák/táblák) és a realized equity (egyszerű vonal/sparkline) a meglévő dashboard-témában; a `Dashboard.tsx`-be bekötve a többi panel mintájára.

---

## 4. Adatfolyam

```
# Liveness
GitHub-runner / Vercel cron → executeScheduledTick
   → runTick → (mentés) → pingHeartbeat(true)   # siker
   → catch → pingHeartbeat(false)               # hiba → /fail
   → healthchecks.io: ha a ping a grace alatt NEM jön → riasztás e-mailben

# Analitika
dashboard → /api/analytics → analytics.ts (getClosedTrades/Breakdowns/EquityCurve)
   → positions + trades + decisions (Neon, no-store) → AnalyticsPanel
```

---

## 5. Hibakezelés / kockázatok

- **A riasztás-ping SOHA ne akassza meg a ticket** → teljes try/catch a `pingHeartbeat`-ben, best-effort, no-op ha nincs env. (Ugyanaz a mintázat, mint az `insertTickRun`-é.)
- **Hamis riasztás a cron-hézagokból** → a grace-period (~90 perc) elnyeli a GitHub-cron ismert késéseit; a period/grace a user-setup doc explicit része.
- **Analitika DB-hiba** → minden fv biztonságos defaultot ad (üres ledger / null stat), nem dob; a panel üres-állapotot mutat.
- **Neon-cache** → a route `no-store` + `force-dynamic` (a már ismert gotcha, lásd a `db/client.ts` `fetchOptions:{cache:"no-store"}`-t).
- **Round-trip P&L pontossága** → a DCA-halmozás miatt egy pozíciónak több BUY-ja lehet; a `pnlUsd` = (záró eladás bevétele) − (a pozícióba fektetett összes BUY költsége), a `positions.entryPrice` (átlagár) × qty alapján. A teszt fixture lefedi a több-BUY esetet.

---

## 6. Tesztelési stratégia

- **TDD a tiszta magokra:**
  - `pingHeartbeat`: env nélkül no-op (nincs fetch-hívás); envvel `ok=true`→URL, `ok=false`→URL+"/fail"; fetch-hiba elnyelve (nem dob). A `fetch` mockolva.
  - `analytics.ts`: `getClosedTrades` round-trip P&L + hold-idő + exit-origin injektált sorokból (több-BUY eset is); `getBreakdowns` win-ráta/átlag coin+origin szerint; `getRealizedEquityCurve` kumulált realized P&L. Mind `dbOverride`-dal, fixture-adaton.
- **Teljes kapu:** `pnpm vitest run` zöld (a meglévő 171 + az újak), `pnpm exec tsc --noEmit` 0, `pnpm build` zöld.
- A route + panel manuális/böngésző-verifikáció (a meglévő dashboard mintára).

---

## 7. Élesítés és mérés

1. `vitest` + `tsc` + `build` zöld.
2. Commit + push master → a runner a köv. tickkor `pingHeartbeat`-el (no-op, amíg a user be nem állítja a `HEARTBEAT_URL`-t).
3. **User-setup:** healthchecks.io check + `HEARTBEAT_URL` secret/env + e-mail-csatorna. Ezután egy szándékos „kihagyott" ping (vagy a grace lejárta) teszteli a riasztást.
4. Az `/api/analytics` + `AnalyticsPanel` éles adaton verifikálva (böngésző).

---

## 8. Siker-kritérium

- A `pingHeartbeat` best-effort, env nélkül no-op; beállított `HEARTBEAT_URL`-lel a healthchecks.io „up"-ot mutat, és egy kihagyott tick **riasztást** vált ki (a user igazolja a setup után).
- Az `AnalyticsPanel` a valódi lezárt trade-eket, a coin/exit-origin bontásokat és a realized equity-görbét mutatja éles adaton.
- A teljes suite + tsc + build **zöld**.
- A `#2` adatai alapján a `#3` (profit-kutatás) **adat-alapon** eldönthető egy későbbi sessionben.

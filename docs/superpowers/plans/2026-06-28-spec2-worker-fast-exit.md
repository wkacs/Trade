# Spec 2 — Always-on worker + gyors exit-sáv — Phase-Gate Plan (PROVIZÓRIKUS)

> ⛔ **NE HAJTSD VÉGRE** ezt a tervet, amíg:
> 1. a **Spec 1 papíron bizonyított** (a momentum/sizing/érme-emelők közül legalább egy a backteszt-kapun túl van, ÉS a live paper-mérés 3–5 napja összevethető a backteszttel), **ÉS**
> 2. le nem fut ennek a fázisnak a **saját, részletes brainstormja** (a nyitott döntések lent).
>
> Ez NEM lépésről-lépésre futtatható TDD-terv — a Spec 2 designja szándékosan vázlat-szintű (lásd `docs/superpowers/specs/2026-06-28-profit-boost-design.md#spec-2`). Ez a fájl a **fázis-váz**: a kapu, a nyitott döntések és a magas szintű task-sor, hogy a fázis elérésekor gyorsan indulhasson a részletes tervezés.

**Goal:** A kockázat-kezelés (stop/take-profit/trailing) percekben hasson, ne órákban — fee-bleed nélkül, megbízható always-on futtatókörnyezetben.

**Architektúra (javasolt):** egy always-on Node-worker `setInterval`-hurokkal, ami egy kód-alapú `fast-exit` modult futtat 5–15 percenként (csak EXIT, LLM nélkül), a meglévő tiszta exit-gépezet (`evaluatePosition` + `ratchetStop`) újrahasználatával, egy közös `planExits()` függvényen át (amit a hourly tick is hív → nincs drift).

---

## Kapu (preconditions) — mindnek teljesülnie kell az indulás előtt

- [ ] Spec 1: legalább egy emelő a backteszt-kapun túl + adoptálva.
- [ ] Spec 1 live paper-mérés: 3–5 nap, realized vs. backteszt összevetve, nincs regresszió.
- [ ] A `tick_runs` napló élesben bizonyítottan ír (a 2026-06-28-i process-transparency feature első éles verifikációja megtörtént).
- [ ] Lefutott a Spec 2 részletes brainstormja (a nyitott döntések eldöntve).

## Nyitott döntések (a fázis-brainstormon kell eldönteni — MOST nem rögzítjük)

1. **Hosting:** Fly.io vs Railway vs Render vs egyéb. Kritérium: ingyenes/olcsó tier, always-on folyamat, egyszerű secret-kezelés, megbízható restart.
2. **Worker hatóköre:** CSAK a gyors exit-sáv (a belépő marad GitHub cronon), VAGY a worker átveszi a hourly tick-et is (a cron-hézagok megszűnnek). *Hajlás: mindkettő a workerben, de ezt a brainstorm dönti el mérés/üzemeltetési szempontból.*
3. **Cadence:** 5 vs 10 vs 15 perc. Trade-off: gyorsabb reakció vs API-rate-limit/zaj.
4. **Élő ár-forrás az exithez:** Binance ticker (REST) vs websocket. MVP: REST poll.
5. **Race-kezelés a hourly tick ↔ fast-exit közt:** a DB single-source elég-e, vagy kell explicit pozíció-lock.

## Magas szintű task-sor (a részletes TDD-lépések a brainstorm UTÁN)

1. **`planExits()` refaktor** — a `planProfitCycle` exit-fele (stop/TP/trailing) kiemelése egy tiszta `planExits(positions, candles, config)` függvénybe; a `planProfitCycle` ÉS az új fast-exit is ezt hívja. **Viselkedés-megőrző refaktor** (a meglévő profit-cycle tesztek zöldek maradnak). *Ez az egyetlen rész, ami már most repón belül, TDD-vel megírható lenne — de a fázis-kapuig nem kezdjük.*
2. **`fast-exit` modul** (`src/lib/engine/fast-exit.ts`) — nyitott pozíciók betöltése + élő ár + `planExits()` + csak EXIT-orderek végrehajtása + `setStopPrice` perzisztálás. Idempotens, LLM nélkül.
3. **Worker runtime** — a választott platformon: hosszú-életű folyamat, `setInterval` hurok, health-check, secret-injektálás (a meglévő DB/LLM env-ek + a `fast-exit`-hez szükségesek).
4. **Koordináció** — a worker hourly-ága (ha átveszi) hívja a meglévő `executeScheduledTick`-et; a fast-exit-ág a 2. pontot; a `tickId`-dedup + DB single-source megakadályozza a duplát.
5. **Üzemeltetés** — monitoring/log, restart-policy, a GitHub cron leállítása/megtartása a 2. döntés szerint.

## Siker-kritérium (a fázis végén)

- Stop/TP **percekben** hajtódik végre (verifikálva a naplóból), nem órákban.
- **Nincs fee-churn:** a trade-szám nem ugrik meg (a fast-exit csak valódi triggerre köt).
- Megbízható cadence — nincs többé többórás hézag.
- A teljes suite + `tsc` + `build` zöld; a `planExits` refaktor nem változtatott viselkedést.

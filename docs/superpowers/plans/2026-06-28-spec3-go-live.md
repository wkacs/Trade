# Spec 3 — Élesre (valódi pénz) — Phase-Gate Plan (PROVIZÓRIKUS)

> ⛔⛔ **NE HAJTSD VÉGRE** ezt a tervet, amíg:
> 1. a **Spec 1 ÉS Spec 2 papíron bizonyított** és pozitív paper-trackkel rendelkezik (nem egy-két nap, hanem értelmes ablak), **ÉS**
> 2. le nem fut ennek a fázisnak a **saját, részletes brainstormja** valódi-pénz kockázat-elemzéssel, **ÉS**
> 3. a felhasználó **kifejezett, tudatos jóváhagyását** adja a live váltásra (valódi pénz forog).
>
> Ez NEM lépésről-lépésre futtatható terv — szándékosan. Valódi pénzes integrációt nem tervezünk meg részletesen olyan paper-eredmények előtt, amik még nem léteznek. A Spec 3 designja vázlat-szintű (lásd `docs/superpowers/specs/2026-06-28-profit-boost-design.md#spec-3`).

**Goal:** A papíron bizonyított stratégiát kicsi, szigorúan limitált valódi pénzes pilotba vinni — verifikált broker, díj-tudatos végrehajtás, kill-switch.

---

## Kapu (preconditions) — KEMÉNY, mind kötelező

- [ ] Spec 1 + Spec 2 élesben (paper) fut, és a realized eredmény **pozitív / a backteszt-várakozással összhangban** egy értelmes ablakon.
- [ ] Lefutott a Spec 3 részletes brainstormja (a nyitott döntések + kockázat-elemzés).
- [ ] A felhasználó kifejezett, írott jóváhagyása a `TRADING_MODE=live` váltásra, a pilot-kerettel együtt.
- [ ] Binance API-kulcs **read+trade only, NO withdraw**, biztonságosan tárolva.

## Nyitott döntések (a fázis-brainstormon — MOST nem rögzítjük)

1. **Pilot-keret:** mekkora valódi tőke (pl. $50–100?), milyen napi veszteség-limit, milyen `maxPositionPct` élesben.
2. **Maker vs taker:** limit-orderrel induljunk (~0% díj, de nem-fill kockázat) vagy market-tel (biztos fill, 0,1% díj)? Fallback-stratégia nem-fill esetén.
3. **Kill-switch mechanizmus:** env-flag vs DB-`settings` kapcsoló; ki/mi billentheti.
4. **Verifikációs út:** Binance **testnet** előbb, majd egyetlen kicsi valódi order oda-vissza.
5. **Skálázási policy:** mikor és hogyan emeljük a tétet (kézi engedélyhez kötve).

## Magas szintű task-sor (részletes TDD-lépések a brainstorm UTÁN)

1. **`BinanceBroker` valódi implementáció** (`src/lib/execution/binance-broker.ts`) — signed REST order-küldés + fill-visszaolvasás + hibakezelés; jelenleg STUB. Testnet-tel tesztelve.
2. **Maker/limit-order út** — limit-ár a spread maker-oldalán; nem-fill kezelése (re-quote/fallback); monitoring. (Ez a Spec 1-ből ide halasztott díj-csökkentő lever.)
3. **Kill-switch** — globális belépő-tiltó kapcsoló; a meglévő `dailyLossCircuitBreakerPct` élesben szigorítható.
4. **Live fee/slippage** — a valódi díj/slippage beépítése a döntés/jelentés útvonalba (a paper szimuláció helyett).
5. **Secrets + env** — `BINANCE_API_KEY`/`BINANCE_API_SECRET` a worker (Spec 2) + a Vercel env-ben; a meglévő secret-minta szerint.
6. **Pilot indítás + szoros monitoring** — kicsi keret, kézi engedély a skálázáshoz, a kill-switch tesztelve.

## Siker-kritérium (a fázis végén)

- `BinanceBroker` verifikált (testnet → egy kicsi valódi order sikeres oda-vissza).
- A pilot a paper-várakozással **összevethető** realized eredményt hoz, a limiteken belül.
- A kill-switch bizonyítottan működik (élő teszt).
- **Soha** tőkeáttétel/margin; a keret szándékosan kicsi a pilotban.

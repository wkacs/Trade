# Ledger-szerződés (v2)

Ez a dokumentum rögzíti, hogyan könyvel a rendszer egy teljesülést, és miért így.
Kapcsolódó feladatok: T02 (szerződés), T03 (séma), T04 (könyvelő), T09 (perzisztencia).

## 1. Alapelvek

1. **Egy igazságforrás.** A készpénz, a készlet, a realizált és a nem realizált eredmény
   MIND ugyanabból a fill-ledgerből származik. A brokernek nincs saját, párhuzamos egyenlege.
2. **Pontosan egyszer.** Egy teljesülés a `fill_key` (mode + tőzsdei orderId + tradeId)
   egyediségén keresztül legfeljebb egyszer mozgat egyenleget. Az ismételt könyvelés nem hiba,
   hanem no-op.
3. **A díj a saját eszközében.** A quote-ban, base-ben vagy harmadik eszközben (pl. BNB)
   fizetett díj külön kezelendő. Az USD-re értékelt díj SOSEM vonódik le másodszor.
4. **Decimális pontosság.** Minden pénzügyi érték `numeric` az adatbázisban és decimális
   szöveg (`Dec`) a kódban. Lásd `src/lib/portfolio/money.ts`.
5. **Hatókör-határ.** Minden sor hordozza a `(portfolio_id, mode)` párt. A paper és a live
   számla soha nem oszt könyvelési sort.

## 2. Táblák

| Tábla | Szerep |
|---|---|
| `execution_intents` | Egy szándék = legfeljebb egy megbízás. `intent_id` és `client_order_id` egyedi. |
| `execution_fills` | Tényleges teljesülések. `fill_key` egyedi. `provenance` jelöli a `legacy-unverified` sorokat. |
| `ledger_cash` | Eszközönkénti egyenleg (USDT és bármely díj-eszköz). CHECK: nem negatív. |
| `ledger_positions` | Készlet és teljes bekerülési érték symbolonként. CHECK: nem negatív. |
| `budget_reservations` | A beküldött, még nem teljesült BUY keretfoglalása. |
| `daily_equity` | UTC napkezdő equity-referencia + napi veszteség-latch. |
| `run_leases` | Egy író: lease + monoton fencing token. |
| `ledger_epochs` | Verziózott mérési szakasz nyitóállapota. |

A v1 táblák (`portfolios`, `positions`, `trades`) VÁLTOZATLANOK. A 0002-es migráció
kizárólag `CREATE TABLE IF NOT EXISTS` és `CREATE INDEX` utasításokat tartalmaz, nem ír át
és nem töröl régi sort, így a meglévő olvasók (dashboard, `/api/portfolio`, analytics)
tovább működnek.

## 3. Driver és tranzakció (ellenőrzött, nem feltételezett)

A telepített `@neondatabase/serverless` 0.9.1 HTTP módban és a `drizzle-orm/neon-http`
0.33.0:

| Képesség | Van? | Bizonyíték |
|---|---|---|
| Interaktív tranzakció | **nincs** | `drizzle-orm/neon-http/session.js:108` — `throw new Error("No transactions support in neon-http driver")` |
| Batch (több utasítás egy tranzakcióban) | van | `session.js:94` — `this.client.transaction(builtQueries, ...)` |
| Szerveroldali SQL-függvény | van | egy `SELECT apply_fill_v2(...)` egyetlen tranzakcióban fut |

A batch nem-interaktív: a következő utasítás nem függhet az előző EREDMÉNYÉTŐL. Egy
fill könyvelése viszont feltételes (duplikátumnál semmi nem mozdulhat), ezért az atomi
műveletet **SQL-függvény** végzi.

## 4. `apply_fill_v2(p_fill jsonb, p_deltas jsonb)`

A DÖNTÉS TypeScriptben van (`ledger.ts` számolja a deltákat, `risk-manager.ts` engedélyez),
a függvény csak alkalmaz. Így nincs két, egymástól elcsúszó könyvelési logika.

```
p_deltas = {
  "cash": [{"asset": "USDT", "delta": "-2.002"}],
  "position": {"symbol": "BTC", "qtyDelta": "0.00003", "costDelta": "2.002", "stopPrice": "57000"},
  "reservation": {"intentId": "…", "consumeQuote": "2.002"}
}
```

Lefutás:

1. `INSERT INTO execution_fills … ON CONFLICT (fill_key) DO NOTHING`.
2. Ha nem szúrt be sort → `{"applied": false, "reason": "duplicate_fill"}`, **semmilyen
   egyenleg nem mozdul**.
3. Egyébként: cash-deltak upsertje, pozíció-delta upsertje (bekerülési érték, opcionális
   stop, `closed_at` nullára fogyáskor), foglalás elszámolása.
4. Visszaadja a friss cash- és pozíció-állapotot.

A CHECK megszorítások (`amount >= 0`, `qty >= 0`) miatt a túlköltés vagy a nem birtokolt
mennyiség eladása a TRANZAKCIÓ BUKÁSÁVAL jár — nem keletkezik negatív egyenleg, és a fill
sem marad bent.

## 5. Kerekítés

- Belső ábrázolás: 18 tizedes fixpontos BigInt (`money.ts`).
- `add`/`sub`: pontos. `mul`/`div`: 18 tizedesre half-up.
- A megjelenítés és a tőzsdei kerekítés explicit módot kér (`floor` | `ceil` | `half-up`);
  a mennyiség lefelé (`floorToStep`), a fedezetigény felfelé kerekül.
- 18 tizedesnél pontosabb bemenetet a `money.ts` ELUTASÍT, nem csonkol csendben.

## 6. Migráció és visszaállás

- A 0002 és 0003 migráció bővítő. Régi migrációt nem írunk át.
- Visszaállás: a v2 táblák eldobása visszaadja a v1 viselkedést, mert a v1 táblákhoz nem
  nyúltunk. Destruktív down-migrációt nem szállítunk; a régi hibás order-út
  visszakapcsolása nem megoldás.
- A tényleges külső (Neon) migráció külön, ütemezett lépés mentéssel és dry-runnal — lásd
  `docs/ledger-migration.md` (T11).

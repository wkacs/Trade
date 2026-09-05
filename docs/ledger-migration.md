# Ledger-migráció és mérési átállás (T11)

Ez a dokumentum írja le, hogyan megy át a régi (v1) paper demó a javított v2 ledgerre,
és mit NEM szabad a régi adatból kikövetkeztetni.

Kapcsolódó: [ledger-contract.md](ledger-contract.md), [tasks/todo.md](../tasks/todo.md) T11.

## 1. Mit tudunk és mit nem a régi adatról

A v1 `trades` tábla korlátai (az auditból, nem feltételezés):

| Korlát | Következmény |
|---|---|
| Nincs megőrzött tőzsdei `orderId` | A régi sorok nem egyeztethetők tőzsdei rekorddal. |
| Néhány soron hiányzik az `origin` | Nem tudjuk, DCA vagy AI vétel volt. |
| A papír stop-fill árak irreálisak lehetnek | A régi kód a stopárat írta fill-árnak akkor is, ha az észlelt ár alacsonyabb volt. |
| Az összegek `real` oszlopban vannak | Az elveszett pontosság utólag NEM állítható vissza. |
| Az eladási díj nem került levonásra a készpénzből | A régi cash-sorozat nem konzisztens a trade-sorokkal. |

Ezekből következik a fő döntés: **a régi trade-sorokat NEM játsszuk vissza egyenlegképző
teljesülésként.** Egy hiányos, kerekített, részben hibás sorozatból nem lehet hiteles
ledgert építeni, és a hiányzó mezők pótlása kitalált adat lenne.

## 2. Az átállás két, szigorúan elkülönített része

1. **Történet.** A régi `trades` sorok bekerülnek az `execution_fills` táblába
   `provenance = 'legacy-unverified'` jelöléssel. Ezek **kizárólag történeti sorok**:
   nem az `apply_fill_v2`-n mennek át, tehát **egyetlen egyenleget sem mozgatnak**.
   A hiányzó tőzsdei azonosító helyére szintetikus, felismerhető `legacy:<trade-uuid>`
   kerül; ez nem tőzsdei adat, és a jelentés ki is mondja.

2. **Nyitóállapot.** Az új mérési epoch nyitóegyenlege a v1 portfólió **ellenőrzött
   aktuális állapota** (készpénz és nyitott pozíciók), nem a trade-ek összege. Az epoch
   a `ledger_epochs` táblába kerül, a nyitó készpénzzel és pozíciókkal együtt.

Az eredeti `portfolios`, `positions` és `trades` sorok **érintetlenek maradnak**.

## 3. Futtatás

```powershell
# 1) DRY-RUN (ez az alapértelmezés — semmit nem ír)
pnpm tsx scripts/migrate-paper-ledger.ts

# 2) A terv és az eltérésjelentés fájlba (gitignore-olt mappa)
pnpm tsx scripts/migrate-paper-ledger.ts --out audit-exports/import-plan.json

# 3) Tényleges import
pnpm tsx scripts/migrate-paper-ledger.ts --apply --epoch v2-2026-09-05
```

A script kiírja:

- az epoch nyitóállapotát,
- az előtte/utána eltérésjelentést a v2 ledgerre,
- a figyelmeztetéseket kódonként összesítve (`missing_origin`, `synthetic_order_id`,
  `suspicious_stop_fill`, `zero_or_negative_amount`, `real_precision_loss`),
- a 20% feletti koncentrációt, ha megadsz `PRICE_<SYMBOL>` env-változókat.

## 4. Kötelező sorrend éles adatbázison

1. **Mentés vagy Neon-branch.** Az import előtt készíts pillanatképet. A Neon-on egy
   branch a legolcsóbb visszaállási pont.
2. **Dry-run a MÁSOLATON.** Futtasd a `--out` kapcsolóval, és nézd át az eltérésjelentést.
3. **Kétszeri import a másolaton.** A második futásnak `legacyFillsInserted: 0`-t és
   `epochCreated: false`-ot kell adnia. Ha nem, ÁLLJ MEG.
4. **Éles import.** Csak ezután, `--apply` kapcsolóval.
5. **Ellenőrzés.** `pnpm audit:state` és a dashboard: a v1 értékek változatlanok, a v2
   ledger a várt nyitóállapotot mutatja.

## 5. Idempotencia

- A történeti fill kulcsa determinisztikus (`mode:legacy:<trade-uuid>:...`), és a
  `execution_fills.fill_key` egyedi → a második beszúrás no-op.
- Az epoch kulcsa `(portfolio_id, mode, epoch_version)` → egyedi.
- A nyitóállapot csak akkor íródik, ha a hatókörben MÉG NINCS `ledger_cash` sor.

Ezért a script kétszer lefuttatva ugyanazt az állapotot adja.

## 6. Amit a migráció szándékosan NEM tesz

- **Nem ad el semmit.** A jelenleg 20% feletti BTC-pozíciót a migráció nem zárja.
  Új vétel erre a coinra a kockázati kapun úgyis fennakad (`no_headroom`), amíg a
  kitettség vissza nem esik a limit alá; a szabályos exit és a védelem működik.
- **Nem javítja** a régi stop-fill árakat, nem pótolja a hiányzó `origin`-t, és nem
  gyárt tőzsdei azonosítót.
- **Nem törli** a régi adatot, és nem indít kereskedést.

## 7. Visszaállás

1. Először az ÚJ intentképzés álljon le (a worker vagy a cron leállítása).
2. Nyitott tőzsdei ordereket egyeztetni kell (T25/T27) — paper módban ez nem értelmezett.
3. A v2 táblák eldobása visszaadja a v1 viselkedést, mert a v1 táblákhoz nem nyúltunk.
   Destruktív down-migrációt nem szállítunk, és a régi hibás order-út visszakapcsolása
   nem megoldás.

## 8. A régi mérés státusza

A régi epoch előtti eredmények **nem hordozhatók át** új mérési bizonyítékként:

- a díjelszámolás hibás volt (az eladási díj nem került le a készpénzből),
- a stop-fill árak túl kedvezők lehettek,
- a napi kapu az indulás óta mért hozamot használta,
- a pozíciólimit nem az összesített kitettséget nézte.

A `docs/verification/baseline-2026-09-05.md` rögzíti a kiindulást. Az új mérés az
epochtól indul; a régi adat megmarad, de `legacy-unverified` minősítéssel.

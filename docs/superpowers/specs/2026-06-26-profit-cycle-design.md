# Profit-Ciklus Design — Stop-Loss + Take-Profit + Fear-Greedy DCA

> **Dátum:** 2026-06-26
> **Típus:** viselkedés-bővítés a meglévő AI-traderre
> **Cél:** a rendszer profit-orientálttá tétele a jelenlegi „mindig HOLD, sosem kereskedik" (DB: 5/5 HOLD, 0 trade) állapotból.

---

## 1. Kontextus és indoklás

A DB-diagnózis (`scripts/diagnose-decisions.ts`) megmutatta, hogy a jelenlegi rendszer **sosem cselekszik**: az utolsó 5 döntés mind HOLD, 0 fizikai trade. A fő ok a phase-1 szűrő túlzott konzervativizmusa — az extrém piaci félelmet (F&G index 13) „nem cselekvésre érdemes"-ként értékeli, holott ez klasszikus **halmozási (BUY) ablak**.

Ez a spec **nem** AI-intuícióra épít (nincs bizonyíték, hogy egy multi-agent bizottság jobb döntést hozna — a konszenzus inkább HOLD felé tol). Helyette **kód-alapú, megbízható szabályokra** épít, amelyek a profit három klasszikus oszlopát valósítják meg:

1. **Védd lefelé** — tényleges stop-loss kiváltás (jelenleg csak rögzítve van, sosem fut)
2. **Realizálj felfelé** — take-profit részleges SELL (jelenleg sosem ad el)
3. **Halmozz olcsón** — fear-greedy DCA kötelező vétellel, amikor a piac érték-alul

Ez a **teljes profit-ciklus**: vesz alacsonyan → korlátozza a veszteséget → realizálja a nyereséget.

## 2. Architektúra — a tick új szerkezete

A `runTick` ciklus kiegészül három **kód-alapú lépéssel**, amelyek a meglévő AI-lánc (phase-1 → phase-2) **előtt** futnak:

```
 TICK (óránként)
   │
   ├─ 1. STOP-LOSS ellenőrzés   (összes nyitott pozícióra)
   │     ha price ≤ stopPrice → automatikus SELL (teljes pozíció)
   │
   ├─ 2. TAKE-PROFIT ellenőrzés (összes nyitott pozícióra)
   │     ha unrealized ≥ +15% → SELL a pozíció FELE (részleges realizálás)
   │
   ├─ 3. FEAR-GREEDY DCA         (ha a piac érték-alul)
   │     F&G ≤ 25 ÉS coin 24h change > -8% → BUY 2% tőke (heti 5% keretből)
   │
   └─ 4. AI-lánc (meglévő)       phase-1 → phase-2, prompt-finomítással:
                                  „extrém félelem = halmozási jel, nem HOLD"
                                  ↑ minden BUY/SELL átmegy a Risk Manageren
```

**Kulcselveletés:** a lépések (1-3) **kód-alapúak** — determinisztikusak, tesztelhetők, nem függenek AI-intuíciótól. Az AI-lánc (4) továbbra is jelen van, de **finomító** szerepben, és a promptja nem torzítja el a félelmet HOLD felé.

## 3. Komponensek

### 3.1 `src/lib/strategy/position-actions.ts` (új)

A stop-loss és take-profit logika tiszta függvényei.

```ts
export interface PositionWithPrice {
  positionId: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  currentPrice: number;
}

export type PositionAction =
  | { kind: "none" }
  | { kind: "stop-loss"; side: "SELL"; qtyFraction: 1.0; reason: string }
  | { kind: "take-profit"; side: "SELL"; qtyFraction: 0.5; reason: string };

/** Eldönti egy pozícióról, kell-e automatikus SELL. */
export function evaluatePosition(p: PositionWithPrice): PositionAction;
```

**Szabályok:**
- `currentPrice ≤ stopPrice` → `stop-loss` (TELJES pozíció eladása, `qtyFraction: 1.0`).
- `(currentPrice - entryPrice) / entryPrice ≥ TAKE_PROFIT_PCT (0.15)` → `take-profit` (a pozíció **fele**, `qtyFraction: 0.5`). Megjegyzés: stop-loss elsőbbséget élvez, ha mindkettő fennáll.
- Egyébként `none`.

### 3.2 `src/lib/strategy/fear-greedy.ts` (új)

A DCA halmozási logika.

```ts
export interface DcaSignal {
  shouldAccumulate: boolean;
  symbol: string | null;        // a legolcsóbb/most esett coin a kosárból
  amountUsd: number;            // 2% tőke
  reason: string;
}

/** Eldönti, van-e DCA-halmozási lehetőség. */
export function evaluateDca(context: {
  fearGreedValue: number | null;        // 0..100, null = nincs adat
  coinChanges: { symbol: string; change24hPct: number }[];
  weeklyBudgetRemainingUsd: number;
  totalEquity: number;
}): DcaSignal;
```

**Szabályok:**
- `fearGreedValue === null` → `shouldAccumulate: false` (nem vak-vásárol adat nélkül).
- `fearGreedValue > DCA_FG_THRESHOLD (25)` → `shouldAccumulate: false` (nem elég olcsó a piac).
- `weeklyBudgetRemainingUsd ≤ 0` → `shouldAccumulate: false` (elfogyott a heti keret).
- Különben: válassza a kosár azon coinját, amelyik `change24hPct > -DCA_MAX_24H_DROP_PCT (-8%)` (nincs szabaduló zuhanás) és a **leginkább esett** (legolcsóbb relatíve). Ha egy sincs ilyen → `shouldAccumulate: false`.
- `amountUsd = totalEquity * DCA_BUY_PCT (0.02)`.

### 3.3 `src/lib/strategy/weekly-budget.ts` (új)

A heti költési keret követése (DCA-fegyelem + vészfék).

```ts
/** Hétfő óta elköltött USD a DCA-vételekre. */
export async function spentThisWeekUsd(): Promise<number>;

/** Hátralévő keret USD-ben (totalEquity * 0.05 − spentThisWeek). */
export async function remainingWeeklyBudget(totalEquity: number): Promise<number>;
```

A `spentThisWeekUsd` a `trades` táblából számol: az elmúlt 7 nap `side='BUY'` és `mode='paper'` sorok `amount_usd` összege. (Megjegyzés: „hét" = görgő 7 nap, nem naptári hétfő — egyszerűbb és konzervatívabb.)

### 3.4 `src/lib/engine/tick.ts` (módosítás)

A `runTick` kiegészül a három lépéssel. Fontos: **a lépések sorrendje számít** (stop → profit → DCA → AI), mert a stop-loss felszabadíthat cash-t, ami a DCA-nál hasznosul.

Új lépések a collectors után, az AI-lánc előtt:
1. Betölti az aktuális árakat (events-ből, CoinGecko).
2. Minden nyitott pozícióra `evaluatePosition()` → ha akció, végrehajtja (SELL, a `accounting.applyTrade`-en keresztül perzisztálva). **Pozíciónként egy-egy külön `applyTrade` hívás** — egy tick több pozíciót is érinthet.
3. `evaluateDca()` → ha `shouldAccumulate`, BUY végrehajtása + perzisztencia.
4. Ezután jön a meglévő AI-lánc (phase-1 → phase-2). **Az AI-lánc függetlenül lefuthat** a fenti lépésektől (pl. másik coinra javasolhat); a különbséget a Risk Manager oldja fel — minden BUY (DCA és AI egyaránt) átmegy a heti limit + pozíció-limit ellenőrzésen, így nem tud duplán túl sokat venni.

### 3.5 `src/lib/risk/risk-manager.ts` (módosítás)

Új heti limit ellenőrzés: ha a heti keret elfogyott, az AI minden BUY-ját HOLD-ra váltja (`overrideReason: "Heti DCA-keret elfogyott"`). Ez garantálja, hogy a heti limit **minden** vételi úton (AI és DCA is) érvényesül.

### 3.6 `src/lib/llm/phase1-filter.ts` + `phase2-decide.ts` (prompt módosítás)

A phase-1 SYSTEM promptba bekerül: *„Extrém alacsony piaci hangulat (Fear & Greed < 25) és jelentős árelésés **cselekvésre érdemes esemény** (potenciális halmozási lehetőség), nem HOLD."* A phase-2 hasonló finomítást kap.

### 3.7 `src/lib/config.ts` (módosítás)

Új konstansok a `RISK_LIMITS` mellé:

```ts
export const PROFIT_CYCLE = {
  /** Take-profit: ha a pozíció ennyit ért el, eladja a felét. */
  takeProfitPct: 0.15,
  /** DCA: Fear & Greed küszöb alatt halmoz. */
  dcaFgThreshold: 25,
  /** DCA: heti költési keret a tőke hányadaként. */
  dcaWeeklyBudgetPct: 0.05,
  /** DCA: egy vétel mérete a tőke hányadaként. */
  dcaBuyPct: 0.02,
  /** DCA: coin 24h esés ezen (abszolút) felett = szabaduló zuhanás, nem veszünk. */
  dcaMax24hDropPct: 0.08,
};
```

## 4. Adatfolyam (egy példa-tick)

**Helyzet:** F&G = 13 (extrém félelem), BTC 24h change = -3% (esett, de stabilizálódik), a portfólióban van egy ETH pozíció +18%-os unrealized nyereséggel, heti keretből $4 maradt.

1. **Stop-loss:** ETH `currentPrice > stopPrice` → `none`. BTC-hez nincs pozíció. *(nem cselekszik)*
2. **Take-profit:** ETH unrealized +18% ≥ 15% → `take-profit`, SELL a fele. → realizálja a nyereséget, cash nő.
3. **DCA:** F&G 13 ≤ 25 ✓, BTC change -3% > -8% ✓, heti keret $4 > 0 ✓ → BUY $0.54 BTC (2% tőke).
4. **AI-lánc:** a prompt finomított — a phase-1 valószínűleg `shouldDecide: true` (mert „extrém félelem = cselekvésre érdemes"). Ha BUY-t javasol, a Risk Manager ellenőrzi a heti limitet.

## 5. Hibakezelés és biztonság

- **F&G adat hiányzik** → `evaluateDca` biztonságból `shouldAccumulate: false`.
- **Heti keret lekérdezés hibája** → konzervatívan úgy számol, min elfogyott volna (HOLD).
- **Stop-loss/take-profit** tiszta függvények — hibátlanul tesztelhetők DB nélkül.
- **Minden akció** (stop, profit, DCA, AI) átmegy az `accounting.applyTrade` perzisztencián és a Risk Manageren.
- **Meglévő biztonság megmarad:** napi -3% circuit breaker, 20% pozíció-limit, 3 egyidejű pozíció limit.

## 6. Tesztelés

- `position-actions.test.ts`: stop-loss (`price ≤ stop`), take-profit (`+15%`), mindkettő (stop elsőbbség), `none` esetek. Tiszta függvények, DB nélkül.
- `fear-greedy.test.ts`: F&G alacsony + stabil ár = BUY; F&G alacsony + zuhanó ár = nem; F&G magas = nem; heti keret elfogyott = nem; nincs F&G adat = nem.
- `weekly-budget.test.ts`: görgő 7 nap számolás, keret maradék.
- `risk-manager.test.ts`: heti limit kimerülése → BUY HOLD-ra vált.
- `tick.test.ts`: a négy lépés együttes lefedése (stop, profit, DCA, AI-út).

## 7. Határok és korlátok (őszintén)

- **Ez nem garantál profitot.** A reális elvárás: veri a „csak HOLD" alapot (mert legalább részt vesz), hosszú táron trend-ben felfelé segíthet, de medvepiacban veszthet — amit a heti keret korlátoz.
- **Take-profit „eladja a felét"** részleges realizálás — a `accounting.applyTrade` SELL ága már kezeli a részleges csökkentést (qty -= trade.qty, csak lezárja ha ≈0).
- **Tőke nagyság:** $27-nél a 2%/vétel = $0,54. Papír módban működik; **live-ra váltásnál** a `dcaBuyPct`-t legalább a broker minimum notional fölé kell emelni (dokumentálva a config-ban).
- **„Hét" = görgő 7 nap**, nem naptári — egyszerűbb és konzervatívabb (sosem „alapít" hetet).

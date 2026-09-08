import { getDb } from "@/db/client";
import { cashOf } from "@/lib/portfolio/ledger";
import { dec } from "@/lib/portfolio/money";
import { activeByClass } from "@/lib/markets/registry";
import { fetchInstrumentCandles } from "@/lib/markets/data";
import {
  runStockCycle,
  stockDecisionDue,
  STOCK_PORTFOLIO_ID,
  STOCK_QUOTE,
  STOCK_STRATEGY,
  type StockCycleAction,
} from "@/lib/engine/stock-tick";
import { etParts, etDateKey, sessionOpenMs } from "@/lib/markets/calendar";
import { resolveDayGate } from "@/lib/portfolio/day-equity";
import {
  hasLedgerState,
  loadLedgerState,
  seedLedger,
  expireStaleReservations,
  reserveBudget,
  releaseReservation,
  recordIntent,
  persistFill,
  persistStopPrice,
  type LedgerScope,
} from "@/lib/execution/order-store";
import { acquireLease, releaseLease, newOwnerId, type Lease } from "@/lib/engine/run-lease";

/** A napi részvény-tick eredménye (a cron route és a runner-script közös visszaadása). */
export interface ScheduledStockTickResult {
  ok: boolean;
  tickId: string;
  skipped?: boolean;
  reason?: string;
  error?: string;
  actions?: StockCycleAction[];
  seeded?: boolean;
  /** Nem végzetes, de NEM elhallgatható figyelmeztetések (pl. duplikált fill). */
  warnings?: string[];
  lease?: { key: string; owner: string; fencingToken: number };
}

/**
 * A fill-könyvelés eredményének ellenőrzése. Az `apply_fill_v2` idempotens: ismert
 * `fill_key`-re `applied: false, reason: "duplicate_fill"`. Ez normál üzemben nem fordul
 * elő, de a napi intent-azonosító determinisztikus (`<ET-dátum>-stock-<origin>-<n>`), így
 * egy `--force`-szal ISMÉTELT napi futás ugyanazt a kulcsot állítaná elő. Ilyenkor a
 * memóriabeli ledger elmozdulna, a DB viszont NEM — ezt tilos elhallgatni.
 */
export function persistWarning(
  intentId: string,
  outcome: { applied: boolean; reason?: string },
): string | null {
  if (outcome.applied) return null;
  return `nem könyvelt fill (${intentId}): ${outcome.reason ?? "ismeretlen ok"} — a DB nem mozdult`;
}

/**
 * A nap végi zárás UTÁN nyitva maradt papírok figyelmeztetése (audit 3. pont).
 *
 * Miért nem elég a log: a zárás kimaradása éjszakai gap-kockázatot hagy bent. A hívó
 * ebből állítja `ok: false`-ra a ciklust — a „lefutott" nem ugyanaz, mint a „lapos".
 */
export function unflattenedWarning(symbols: string[]): string | null {
  if (symbols.length === 0) return null;
  return `NYITVA MARADT kitettség a nap végi zárás után: ${symbols.join(", ")} — éjszakai gap-kockázat, kézi ellenőrzés kell`;
}

/** Napi lezárás után annyi bar, hogy a leghosszabb visszatekintés (momentum 48) is elférjen. */
const STOCK_BARS = 90;
/** A napi lease élettartama — hosszú, hogy ugyanarra a napra ne fusson kétszer. */
const STOCK_LEASE_TTL_MS = 20 * 60 * 60 * 1000;

function stockCapitalUsd(): string {
  const raw = process.env.STOCK_PAPER_CAPITAL_USD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? String(n) : "10000";
}

export interface ScheduledStockTickOptions {
  now?: () => number;
  /** Kihagyja a cadence-kaput (kézi, egyszeri futtatás). */
  force?: boolean;
  owner?: string;
}

/**
 * A teljes NAPI részvény-tick, HTTP/auth NÉLKÜL. A kripto `executeScheduledTick` mintája,
 * de USD-scope-pal, napi ritmussal és a részvény-motorral (`runStockCycle`).
 *
 *   1) cadence-kapu: a döntés az ülés ZÁRÁSA után esedékes, naponta egyszer
 *   2) napi LEASE (a dupla napi futás kizárása)
 *   3) a `stock-paper` USD-ledger seedelése, ha még üres
 *   4) aktív részvény-instrumentumok napi gyertyái (Stooq)
 *   5) runStockCycle a KÖZÖS végrehajtási úton, VALÓS perzisztenciával
 */
export async function executeScheduledStockTick(
  options: ScheduledStockTickOptions = {},
): Promise<ScheduledStockTickResult> {
  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const tickId = etDateKey(etParts(nowMs));
  const db = getDb();

  // 1) Cadence — csak az ülés zárása után, naponta egyszer (kézi futásnál --force).
  const gate = stockDecisionDue(nowMs, null);
  if (!gate.due && !options.force) {
    return { ok: true, skipped: true, tickId, reason: `cadence:${gate.reason}` };
  }

  if (!db) {
    return { ok: true, skipped: true, tickId, reason: "no_database" };
  }

  // 2) Napi lease erre a kereskedési napra.
  const owner = options.owner ?? newOwnerId("stock-tick");
  const key = `stock-daily:${tickId}`;
  const lease: Lease = await acquireLease(key, owner, STOCK_LEASE_TTL_MS);
  if (!lease.acquired) {
    return { ok: true, skipped: true, tickId, reason: "lease_held", lease: { key, owner: lease.heldBy ?? "?", fencingToken: lease.fencingToken } };
  }

  const scope: LedgerScope = { portfolioId: STOCK_PORTFOLIO_ID, mode: "paper" };
  const warnings: string[] = [];
  const fence = { leaseKey: key, owner, fencingToken: lease.fencingToken };
  /** A result `lease` mezője `key`-t vár (a fence `leaseKey`-t az order-store-nak). */
  const leaseInfo = { key, owner, fencingToken: lease.fencingToken };

  try {
    // 3) Seed a részvény USD-pénztárcát, ha még üres.
    let seeded = false;
    if (!(await hasLedgerState(scope))) {
      await seedLedger(scope, dec(stockCapitalUsd()), [], STOCK_QUOTE);
      seeded = true;
      console.log(`[stock-tick] a stock-paper USD-ledger seedelve: ${stockCapitalUsd()} USD`);
    }
    let ledger = await loadLedgerState(scope, STOCK_QUOTE);
    await expireStaleReservations(scope);

    // 4) Aktív részvények napi gyertyái.
    const instruments = activeByClass("stock");
    if (instruments.length === 0) {
      await releaseLease(key, owner);
      return { ok: true, skipped: true, tickId, reason: "no_active_stocks", seeded, lease: leaseInfo };
    }
    const candlesBySymbol: Record<string, Awaited<ReturnType<typeof fetchInstrumentCandles>>["candles"]> = {};
    for (const inst of instruments) {
      const { candles, error } = await fetchInstrumentCandles(inst, STOCK_BARS, { now });
      if (error) {
        console.warn(`[stock-tick] ${inst.symbol} adat-hiba [${error.code}] ${error.message}`);
        continue;
      }
      if (candles.length > 0) candlesBySymbol[inst.symbol] = candles;
    }

    // 5) A közös végrehajtási út VALÓS perzisztenciával (a runTick hookjainak tükre).
    const result = await runStockCycle({
      tickId,
      now,
      ledger,
      instruments,
      candlesBySymbol,
      weeklyBudgetRemainingUsd: Number(cashOf(ledger, STOCK_QUOTE)) * 0.05,
      // NAPI VESZTESÉGKAPU (audit 1. pont) — ülés-nap, közös sor az intraday sávval
      // (ugyanaz a stock-paper pénztárca), a kriptótól elkülönítve.
      resolveDayGate: async (equityUsd, nowMs) => {
        const gate = await resolveDayGate(
          scope.portfolioId,
          scope.mode,
          equityUsd,
          dec(STOCK_STRATEGY.dailyLossCircuitBreakerPct),
          nowMs,
          undefined,
          { dayKey: etDateKey(etParts(nowMs)), dayStartMs: sessionOpenMs(nowMs) },
        );
        if (gate.latched || gate.dayPnlPct === null) {
          console.warn(`[stock-tick] napi kapu: ${gate.reason}`);
        }
        return { latched: gate.latched, baselineMissing: gate.dayPnlPct === null };
      },
      reserve: async (intent, quote) => reserveBudget(intent, quote, cashOf(ledger, STOCK_QUOTE), undefined, fence),
      releaseReservation: async (intent) => {
        await releaseReservation(intent.intentId);
      },
      recordIntent: async (intent, receipt) => {
        await recordIntent(intent, receipt);
      },
      persist: async (intent, fill, deltas) => {
        const outcome = await persistFill(intent, fill, { ...deltas, fence });
        const warning = persistWarning(intent.intentId, outcome);
        if (warning) {
          console.warn(`[stock-tick] ${warning}`);
          warnings.push(warning);
        }
        return outcome;
      },
      persistStop: async (symbol, stopPrice) => {
        await persistStopPrice(scope, symbol, stopPrice);
      },
    });
    ledger = result.ledger;

    console.log(`[stock-tick] ${tickId}: ${result.actions.length} akció`);
    return {
      ok: true,
      tickId,
      actions: result.actions,
      seeded,
      lease: leaseInfo,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (e) {
    console.error("[stock-tick] ciklus hiba:", e);
    await releaseLease(key, owner);
    return { ok: false, tickId, error: String(e), lease: leaseInfo };
  }
}

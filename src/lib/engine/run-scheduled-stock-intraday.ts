import { getDb } from "@/db/client";
import { cashOf } from "@/lib/portfolio/ledger";
import { dec } from "@/lib/portfolio/money";
import { activeByClass } from "@/lib/markets/registry";
import { fetchInstrumentCandles } from "@/lib/markets/data";
import {
  runStockCycle,
  intradayPhaseAt,
  STOCK_PORTFOLIO_ID,
  STOCK_QUOTE,
  STOCK_INTRADAY_TF,
  STOCK_INTRADAY_BARS,
  STOCK_INTRADAY_STRATEGY,
  STOCK_INTRADAY_STRATEGY_VERSION,
  type StockCycleAction,
  type IntradayPhase,
} from "@/lib/engine/stock-tick";
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
import { acquireLease, releaseLease, newOwnerId, slotId, type Lease } from "@/lib/engine/run-lease";
import { persistWarning } from "@/lib/engine/run-scheduled-stock-tick";

/**
 * DAY TRADING részvény-ciklus — 5 percenként, az amerikai ülés alatt.
 *
 * A napi (swing) `executeScheduledStockTick` párja, de:
 *  - 5 perces gyertyán dolgozik (`STOCK_INTRADAY_TF`), nem napin,
 *  - az ülés FÁZISA vezérli (`intradayPhaseAt`): kereskedés → belépő-stop → laposra zárás,
 *  - a lease az 5 perces IDŐSÁVRA szól, tehát a következő sáv szabadon fut.
 *
 * Ugyanaz a pénztárca (`stock-paper`, USD) és ugyanaz a végrehajtási út, mint a swing
 * ágé — a részvény-sáv EGY sáv, csak most day-trading ritmusban.
 */

/** Az 5 perces idősáv hossza — a külső cron ilyen ütemben hívja a ciklust. */
export const INTRADAY_SLOT_MS = 5 * 60 * 1000;

export interface ScheduledStockIntradayResult {
  ok: boolean;
  slot: string;
  phase: IntradayPhase;
  skipped?: boolean;
  reason?: string;
  error?: string;
  actions?: StockCycleAction[];
  seeded?: boolean;
  /** Nem végzetes, de NEM elhallgatható figyelmeztetések (pl. duplikált fill). */
  warnings?: string[];
  lease?: { key: string; owner: string; fencingToken: number };
}

function stockCapitalUsd(): string {
  const raw = process.env.STOCK_PAPER_CAPITAL_USD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? String(n) : "10000";
}

export interface ScheduledStockIntradayOptions {
  now?: () => number;
  /** Kihagyja az ülés-kaput (kézi, egyszeri próba zárt piacon is). */
  force?: boolean;
  owner?: string;
}

/**
 * Egyetlen 5 perces day-trading ciklus.
 *
 *   1) ülés-kapu: zárt piacon nincs mit tenni (kivéve `--force`)
 *   2) idősáv-LEASE (egy ciklus fut az 5 perces sávban)
 *   3) a `stock-paper` USD-ledger seedelése, ha még üres
 *   4) 5 perces gyertyák a Yahoo-ról az aktív részvényekre
 *   5) runStockCycle a KÖZÖS végrehajtási úton, VALÓS perzisztenciával, fázis szerint
 */
export async function executeScheduledStockIntraday(
  options: ScheduledStockIntradayOptions = {},
): Promise<ScheduledStockIntradayResult> {
  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const slot = slotId(nowMs, INTRADAY_SLOT_MS);
  const gate = intradayPhaseAt(nowMs);
  const db = getDb();

  if (!gate.due && !options.force) {
    return { ok: true, skipped: true, slot, phase: gate.phase, reason: `session:${gate.reason}` };
  }
  const phase: IntradayPhase = gate.due ? gate.phase : "trading";

  if (!db) {
    return { ok: true, skipped: true, slot, phase, reason: "no_database" };
  }

  // Az idősáv-lease: ugyanabban az 5 percben egy ciklus fut, de a következő sáv szabad.
  const owner = options.owner ?? newOwnerId("stock-intraday");
  const key = `stock-intraday:${slot}`;
  const lease: Lease = await acquireLease(key, owner, Math.floor(INTRADAY_SLOT_MS * 0.9));
  if (!lease.acquired) {
    return {
      ok: true,
      skipped: true,
      slot,
      phase,
      reason: "lease_held",
      lease: { key, owner: lease.heldBy ?? "?", fencingToken: lease.fencingToken },
    };
  }

  const scope: LedgerScope = { portfolioId: STOCK_PORTFOLIO_ID, mode: "paper" };
  const fence = { leaseKey: key, owner, fencingToken: lease.fencingToken };
  const leaseInfo = { key, owner, fencingToken: lease.fencingToken };
  const warnings: string[] = [];

  try {
    let seeded = false;
    if (!(await hasLedgerState(scope))) {
      await seedLedger(scope, dec(stockCapitalUsd()), [], STOCK_QUOTE);
      seeded = true;
      console.log(`[stock-intraday] a stock-paper USD-ledger seedelve: ${stockCapitalUsd()} USD`);
    }
    let ledger = await loadLedgerState(scope, STOCK_QUOTE);
    await expireStaleReservations(scope);

    const instruments = activeByClass("stock");
    if (instruments.length === 0) {
      await releaseLease(key, owner);
      return { ok: true, skipped: true, slot, phase, reason: "no_active_stocks", seeded, lease: leaseInfo };
    }

    const candlesBySymbol: Record<string, Awaited<ReturnType<typeof fetchInstrumentCandles>>["candles"]> = {};
    for (const inst of instruments) {
      const { candles, error } = await fetchInstrumentCandles(inst, STOCK_INTRADAY_BARS, {
        now,
        timeframe: STOCK_INTRADAY_TF,
      });
      if (error) {
        console.warn(`[stock-intraday] ${inst.symbol} adat-hiba [${error.code}] ${error.message}`);
        continue;
      }
      if (candles.length > 0) candlesBySymbol[inst.symbol] = candles;
    }
    if (Object.keys(candlesBySymbol).length === 0) {
      await releaseLease(key, owner);
      return { ok: false, slot, phase, reason: "no_candles", error: "Egyetlen instrumentumra sincs gyertya.", lease: leaseInfo };
    }

    const result = await runStockCycle({
      tickId: slot,
      now,
      ledger,
      instruments,
      candlesBySymbol,
      timeframe: STOCK_INTRADAY_TF,
      phase,
      strategy: STOCK_INTRADAY_STRATEGY,
      strategyVersion: STOCK_INTRADAY_STRATEGY_VERSION,
      weeklyBudgetRemainingUsd: Number(cashOf(ledger, STOCK_QUOTE)) * 0.05,
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
          console.warn(`[stock-intraday] ${warning}`);
          warnings.push(warning);
        }
      },
      persistStop: async (symbol, stopPrice) => {
        await persistStopPrice(scope, symbol, stopPrice);
      },
    });
    ledger = result.ledger;

    if (result.actions.length > 0) {
      console.log(`[stock-intraday] ${slot} (${phase}): ${result.actions.length} akció`);
    }
    return {
      ok: true,
      slot,
      phase,
      actions: result.actions,
      seeded,
      lease: leaseInfo,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (e) {
    console.error("[stock-intraday] ciklus hiba:", e);
    await releaseLease(key, owner);
    return { ok: false, slot, phase, error: String(e), lease: leaseInfo };
  }
}

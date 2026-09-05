/**
 * Gyors kilépés-ciklus (T21) — LLM és hírgyűjtők NÉLKÜL.
 *
 * Az audit B. szakasza: a motor a profit-ciklus előtt megvárta az ÖSSZES collectort,
 * köztük az RSS-t. Egy lassú hírforrás így késleltette a stop-loss végrehajtását.
 *
 * Ez a ciklus KIZÁRÓLAG friss árra vár:
 *   quote lekérés → kilépés-terv → közös kockázati kapu → közös fill-könyvelő
 *
 * Amit SOHA nem csinál: nem vesz, nem hív LLM-et, nem vár hírre, és elavult áron nem lép ki.
 */
import { COIN_UNIVERSE, RISK_LIMITS } from "@/lib/config";
import { DEFAULT_STRATEGY, STRATEGY_VERSION, type StrategyConfig } from "@/lib/strategy/config";
import { fetchQuotes, checkExecutionQuote, DEFAULT_QUOTE_MAX_AGE_MS, type QuoteSnapshot } from "@/lib/market/quotes";
import { planExits, exitPositionsFromLedger, type ExitPlan } from "@/lib/engine/plan-exits";
import {
  planProtection,
  protectionGate,
  incidentsFromOutcomes,
  type ExecutionOutcome,
  type ProtectionOrder,
  type ProtectionIncident,
} from "@/lib/execution/protection";
import type { SymbolFilters } from "@/lib/execution/exchange-rules";
import { executeIntent, type ExecuteIntentDeps } from "@/lib/engine/execute-intent";
import { PaperExecutionBroker } from "@/lib/execution/paper-broker";
import { BinanceBroker, BinanceLegacyExecutionAdapter } from "@/lib/execution/binance-broker";
import type { ExecutionBroker } from "@/lib/execution/broker";
import type { Fill, TradingMode } from "@/lib/execution/contracts";
import { loadLedgerState, loadReservations, persistFill, persistStopPrice, listUnsettledIntents } from "@/lib/execution/order-store";
import { setStop, type LedgerState } from "@/lib/portfolio/ledger";
import { DEFAULT_ORDER_RISK_PARAMS } from "@/lib/risk/risk-manager";
import { type Dec, ZERO, dec, toNumber } from "@/lib/portfolio/money";

export interface FastExitInput {
  portfolioId: string;
  mode: TradingMode;
  /** A ciklus azonosítója (idősáv + sorszám) — az intent-azonosítók magja. */
  cycleId: string;
  strategy?: StrategyConfig;
  now?: () => number;
  maxQuoteAgeMs?: number;
  fence?: { leaseKey: string; owner: string; fencingToken: number };
  /** Teszthez injektálható függőségek. */
  deps?: Partial<FastExitDeps>;
}

export interface FastExitDeps {
  fetchQuotes: typeof fetchQuotes;
  /** A tőzsdén ÜLŐ védőorderek (live módban). Paperben üres. */
  loadProtection: (scope: { portfolioId: string; mode: TradingMode }) => Promise<Record<string, ProtectionOrder | undefined>>;
  /** A szimbólum-szűrők (T24). Paperben üres. */
  loadFilters: () => Promise<Record<string, SymbolFilters | undefined>>;
  loadLedger: (scope: { portfolioId: string; mode: TradingMode }) => Promise<LedgerState>;
  loadReservations: typeof loadReservations;
  listUnsettledIntents: typeof listUnsettledIntents;
  persistFill: typeof persistFill;
  persistStopPrice: typeof persistStopPrice;
  makeBroker: (getLedger: () => LedgerState, quotes: QuoteSnapshot, now: () => number) => ExecutionBroker;
  executeProtection: (actions: import("@/lib/execution/protection").ProtectionAction[]) => Promise<ExecutionOutcome[]>;
}

export interface FastExitResult {
  cycleId: string;
  /** Védőorder-incidensek (T26). Blokkoló incidens mellett ÚJ VÉTEL TILOS. */
  protectionIncidents: ProtectionIncident[];
  /** Igaz, ha a védelem állapota miatt új vétel nem indítható. */
  newBuysBlocked: boolean;
  /** A ténylegesen végrehajtott kilépések. */
  fills: Fill[];
  plan: ExitPlan;
  quotes: { maxAgeMs: number; degraded: boolean; missing: string[] };
  /** Miért nem futott le a ciklus, ha nem futott. */
  halted?: "unsettled_intents" | "no_positions" | "no_quotes";
  stopUpdatesApplied: number;
  /** Az elutasított kilépések oka (kockázati kapu vagy broker). */
  rejections: Record<string, number>;
  durationMs: number;
  protectionOutcomes: ExecutionOutcome[];
}

function defaultDeps(): FastExitDeps {
  return {
    fetchQuotes,
    // Paper módban nincs tőzsdén ülő védőorder; a live út a T27-ben kapja meg a forrást.
    loadProtection: async () => ({}),
    loadFilters: async () => ({}),
    loadLedger: (scope) => loadLedgerState(scope),
    loadReservations,
    listUnsettledIntents,
    persistFill,
    persistStopPrice,
    makeBroker: (getLedger, quotes, now) =>
      new PaperExecutionBroker({
        getLedger,
        getMarket: (symbol) => {
          const q = quotes.quotes[symbol];
          return q ? { bid: q.bid, ask: q.ask, last: q.mid } : null;
        },
        now,
      }),
    executeProtection: async () => [],
  };
}

/**
 * Egy gyors kilépés-ciklus. Determinisztikus a bemeneteire: az idő, a quote-lekérés és a
 * perzisztencia mind injektálható.
 */
export async function runFastExit(input: FastExitInput): Promise<FastExitResult> {
  const deps: FastExitDeps = { ...defaultDeps(), ...input.deps };
  const now = input.now ?? (() => Date.now());
  const strategy = input.strategy ?? DEFAULT_STRATEGY;
  const maxQuoteAgeMs = input.maxQuoteAgeMs ?? DEFAULT_QUOTE_MAX_AGE_MS;
  const scope = { portfolioId: input.portfolioId, mode: input.mode };
  const started = now();
  const rejections: Record<string, number> = {};
  const emptyPlan: ExitPlan = { exits: [], stopUpdates: [], skipped: [] };

  // 1) Ismeretlen állapotú megbízás mellett NEM küldünk újat — egyeztetés jár.
  const unsettled = await deps.listUnsettledIntents(scope);
  if (unsettled.length > 0) {
    return {
      cycleId: input.cycleId,
      fills: [],
      plan: emptyPlan,
      protectionIncidents: [],
      newBuysBlocked: false,
      quotes: { maxAgeMs: 0, degraded: true, missing: [] },
      halted: "unsettled_intents",
      stopUpdatesApplied: 0,
      rejections,
      durationMs: now() - started,
      protectionOutcomes: [],
    };
  }

  let ledger = await deps.loadLedger(scope);
  const positions = exitPositionsFromLedger(ledger.positions);
  if (positions.length === 0) {
    return {
      cycleId: input.cycleId,
      fills: [],
      plan: emptyPlan,
      protectionIncidents: [],
      newBuysBlocked: false,
      quotes: { maxAgeMs: 0, degraded: false, missing: [] },
      halted: "no_positions",
      stopUpdatesApplied: 0,
      rejections,
      durationMs: now() - started,
      protectionOutcomes: [],
    };
  }

  // 2) CSAK friss árra várunk — se hírre, se sentimentre, se LLM-re.
  const symbols = positions.map((p) => p.symbol);
  const quotes = await deps.fetchQuotes(symbols, { now, maxAgeMs: maxQuoteAgeMs });
  const missing = symbols.filter((s) => !quotes.quotes[s]);
  if (Object.keys(quotes.quotes).length === 0) {
    return {
      cycleId: input.cycleId,
      fills: [],
      plan: emptyPlan,
      protectionIncidents: [],
      newBuysBlocked: false,
      quotes: { maxAgeMs: quotes.maxAgeMs, degraded: true, missing },
      halted: "no_quotes",
      stopUpdatesApplied: 0,
      rejections,
      durationMs: now() - started,
      protectionOutcomes: [],
    };
  }

  // 3) Kilépés-terv — a KÖZÖS tervezővel (az órás ág ugyanezt hívja).
  const plan = planExits(
    { positions, quotes: quotes.quotes, nowMs: now(), maxQuoteAgeMs, inFlightSymbols: [] },
    strategy,
  );

  // Live számlán a pihenő stop-order zárolja a készletet. A market exit előtt ezért
  // koordináltan töröljük; sikertelen cancel után nem küldünk eleve fedezethiányos SELL-t.
  const existingProtection = input.mode === "live" ? await deps.loadProtection(scope) : {};
  const protectionFilters = input.mode === "live" ? await deps.loadFilters() : {};
  const protectionOutcomes: ExecutionOutcome[] = [];
  const protectionFilledSymbols = new Set<string>();

  // 4) Trailing ratchet perzisztálása (sosem lefelé).
  let stopUpdatesApplied = 0;
  for (const u of plan.stopUpdates) {
    ledger = setStop(ledger, u.symbol, u.newStop);
    if (await deps.persistStopPrice(scope, u.symbol, u.newStop)) stopUpdatesApplied++;
  }

  // 5) Végrehajtás a KÖZÖS úton. BUY-t itt SOHA nem hozunk létre.
  const reservations = await deps.loadReservations(scope);
  const broker = deps.makeBroker(() => ledger, quotes, now);
  const fills: Fill[] = [];
  let seq = 0;

  for (const exit of plan.exits) {
    const resting = existingProtection[exit.symbol];
    if (input.mode === "live" && resting) {
      const [cancelOutcome] = await deps.executeProtection([{
        kind: "cancel", symbol: exit.symbol, cancelOrderId: resting.exchangeOrderId,
        reason: `A ${exit.kind} market exit előtt a zárolt készlet felszabadítása.`,
      }]);
      if (cancelOutcome) protectionOutcomes.push(cancelOutcome);
      if (cancelOutcome?.filledDuringReplace) {
        protectionFilledSymbols.add(exit.symbol);
        delete existingProtection[exit.symbol];
      }
      if (!cancelOutcome?.ok || cancelOutcome.filledDuringReplace) {
        rejections[cancelOutcome?.filledDuringReplace ? "protection_filled_before_exit" : "protection_cancel_failed"] =
          (rejections[cancelOutcome?.filledDuringReplace ? "protection_filled_before_exit" : "protection_cancel_failed"] ?? 0) + 1;
        continue;
      }
      delete existingProtection[exit.symbol];
    }
    const check = checkExecutionQuote(quotes, exit.symbol, now(), maxQuoteAgeMs);
    if (!check.ok) {
      rejections[`quote_${check.reason}`] = (rejections[`quote_${check.reason}`] ?? 0) + 1;
      continue;
    }

    const execDeps: ExecuteIntentDeps = {
      portfolioId: input.portfolioId,
      mode: input.mode,
      strategyVersion: STRATEGY_VERSION,
      broker,
      getLedger: () => ledger,
      getRiskContext: () => ({
        ledger,
        prices: Object.fromEntries(Object.entries(quotes.quotes).map(([s, q]) => [s, q.mid])) as Record<string, Dec>,
        reservedQuoteBySymbol: reservations.bySymbol,
        reservedQuoteTotal: reservations.total,
        // A kilépést a napi kapu SOHA nem tiltja.
        dailyLossLatched: false,
        dayBaselineMissing: false,
        allowedSymbols: [...COIN_UNIVERSE],
        quoteAsset: "USDT",
      }),
      riskParams: {
        ...DEFAULT_ORDER_RISK_PARAMS,
        maxPositionPct: dec(RISK_LIMITS.maxPositionPct),
        maxConcurrentPositions: RISK_LIMITS.maxConcurrentPositions,
      },
      now,
      newIntentId: () => `${input.cycleId}-${exit.kind}-${++seq}`,
      persist: async (intent, fill, deltas) => {
        await deps.persistFill(intent, fill, input.fence ? { ...deltas, fence: input.fence } : deltas);
      },
    };

    const outcome = await executeIntent(
      {
        side: "SELL",
        symbol: exit.symbol,
        baseQty: exit.baseQty,
        origin: exit.kind,
        referencePrice: check.quote.bid,
        trigger: { kind: exit.kind, triggerPrice: exit.triggerPrice },
      },
      execDeps,
    );

    if (outcome.status === "executed") {
      ledger = outcome.ledger;
      fills.push(...outcome.fills);
    } else if (outcome.status === "rejected_by_risk") {
      rejections[outcome.code] = (rejections[outcome.code] ?? 0) + 1;
    } else if (outcome.status === "rejected_by_broker") {
      rejections[outcome.code] = (rejections[outcome.code] ?? 0) + 1;
    } else if (outcome.status === "unknown") {
      rejections.unknown = (rejections.unknown ?? 0) + 1;
    }
  }

  // ── 6) Védőorder-életciklus (T26). A DB-stop frissítése ÖNMAGÁBAN nem módosítja a
  //      tőzsdén ülő ordert, ezért a tervet itt állítjuk elő; a blokkoló incidens
  //      megtiltja az új vételt, amíg fenn nem oldódik.
  const protection = input.mode === "live" ? planProtection(
    {
      positions: exitPositionsFromLedger(ledger.positions).filter((p) => !protectionFilledSymbols.has(p.symbol)).map((p) => ({
        symbol: p.symbol,
        qty: p.qty,
        desiredStop: p.stopPrice,
      })),
      existing: existingProtection,
      filters: protectionFilters,
    },
    strategy,
  ) : { actions: [], incidents: [] };
  if (input.mode === "live") protectionOutcomes.push(...await deps.executeProtection(protection.actions));
  const protectionIncidents = [...protection.incidents, ...incidentsFromOutcomes(protectionOutcomes)];
  const gate = protectionGate(protectionIncidents);
  for (const i of protectionIncidents) {
    if (i.blocksNewBuys) console.error(`[fast-exit] VÉDELMI INCIDENS ${i.code} (${i.symbol}): ${i.message}`);
  }

  return {
    cycleId: input.cycleId,
    fills,
    plan,
    protectionIncidents,
    protectionOutcomes,
    newBuysBlocked: !gate.allowNewBuys,
    quotes: { maxAgeMs: quotes.maxAgeMs, degraded: quotes.degraded, missing },
    stopUpdatesApplied,
    rejections,
    durationMs: now() - started,
  };
}

/** Live broker a gyors ághoz (a T25-ig az átmeneti adapterrel). */
export function liveExitBroker(now: () => number = () => Date.now()): ExecutionBroker {
  return new BinanceLegacyExecutionAdapter(
    new BinanceBroker(process.env.BINANCE_API_KEY ?? "", process.env.BINANCE_API_SECRET ?? ""),
    RISK_LIMITS.stopLossPct,
    now,
  );
}

export { ZERO, toNumber };

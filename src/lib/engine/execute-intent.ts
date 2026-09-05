/**
 * Egyetlen végrehajtási út (T06) — ide érkezik MINDEN order: AI, DCA, momentum,
 * stop-loss, take-profit és kézi.
 *
 * A régi kódban a kód-alapú profit-ciklus közvetlenül épített trade-et, megkerülve a
 * Risk Managert (audit §4), az AI-út pedig külön számolt méretet. Innentől egy sorrend
 * van, és a broker CSAK jóváhagyott, még érvényes intentet kaphat:
 *
 *   1) intent felépítése (stabil azonosító, lejárat, hatókör)
 *   2) kockázati kapu (evaluateOrder) — a kapu vághat, de nem tehet nagyobbá
 *   3) keretfoglalás (opcionális; a T09 köti DB-hez)
 *   4) broker.submit → nyugta (fill vagy strukturált elutasítás)
 *   5) a fillek könyvelése a KÖZÖS ledgerrel, majd perzisztálás (opcionális hook)
 *
 * Tiszta a hálózat és az idő felé: minden IO injektált.
 */
import {
  EXECUTION_CONTRACT_VERSION,
  type ExecutionIntent,
  type Fill,
  type TradingMode,
} from "@/lib/execution/contracts";
import type { ExecutionBroker, ExecutionReceipt } from "@/lib/execution/broker";
import type { TradeOrigin } from "@/lib/engine/tick-process";
import {
  applyFill,
  withReservation,
  type LedgerState,
  type SqlDeltas,
} from "@/lib/portfolio/ledger";
import {
  evaluateOrder,
  type OrderRiskContext,
  type OrderRiskParams,
  type RiskRejectCode,
  DEFAULT_ORDER_RISK_PARAMS,
} from "@/lib/risk/risk-manager";
import { type Dec, ZERO, add } from "@/lib/portfolio/money";

export interface IntentRequest {
  side: "BUY" | "SELL";
  symbol: string;
  /** BUY: a KÍVÁNT költés quote-ban (a kapu ezt vághatja lefelé). */
  desiredQuote?: Dec;
  /** SELL: a KÍVÁNT mennyiség (a kapu a birtokoltra vágja). */
  baseQty?: Dec;
  origin: TradeOrigin;
  referencePrice: Dec;
  /** stop-loss / take-profit trigger — a paper fill-modell ezt használja. */
  trigger?: { kind: "stop-loss" | "take-profit"; triggerPrice: Dec };
  /**
   * BUY után beállítandó stop-ár. Ha nincs megadva, a MEGLÉVŐ stop marad — a rávásárlás
   * így nem viheti lejjebb a már felhúzott trailing stopot (audit §4).
   */
  stopPrice?: Dec;
}

export interface ExecuteIntentDeps {
  portfolioId: string;
  mode: TradingMode;
  strategyVersion: string;
  broker: ExecutionBroker;
  /** A közös ledger aktuális állapota (a hívó tartja). */
  getLedger: () => LedgerState;
  /** A kockázati kontextus a friss ledgerből. */
  getRiskContext: () => OrderRiskContext;
  riskParams?: OrderRiskParams;
  now: () => number;
  /** Egyedi intent-azonosító. Injektálva, hogy a teszt determinisztikus legyen. */
  newIntentId: () => string;
  /** Meddig érvényes egy intent (ms). Az elavult árra épülő order nem hajtható végre. */
  intentTtlMs?: number;
  /**
   * Keretfoglalás létrehozása a beküldés ELŐTT (T09 köti DB-hez). Igaz visszatérés
   * esetén megyünk tovább; hamisnál nem küldünk ordert.
   */
  reserve?: (intent: ExecutionIntent, quote: Dec) => Promise<boolean>;
  /** A foglalás elengedése, ha nem lett (teljes) fill. */
  releaseReservation?: (intent: ExecutionIntent) => Promise<void>;
  /** A fill(ek) tartós könyvelése. Hiba esetén DOBNI kell — nem néma siker. */
  persist?: (intent: ExecutionIntent, fill: Fill, deltas: SqlDeltas) => Promise<void>;
  /** Az intent állapotának naplózása (beküldés, elutasítás, ismeretlen). */
  recordIntent?: (intent: ExecutionIntent, receipt: ExecutionReceipt | null) => Promise<void>;
}

export type ExecuteIntentOutcome =
  | { status: "executed"; intent: ExecutionIntent; fills: Fill[]; ledger: LedgerState; reasons: string[] }
  | { status: "rejected_by_risk"; code: RiskRejectCode; reasons: string[]; ledger: LedgerState }
  | { status: "rejected_by_broker"; intent: ExecutionIntent; code: string; message: string; ledger: LedgerState }
  | { status: "unknown"; intent: ExecutionIntent; message: string; ledger: LedgerState }
  | { status: "not_reserved"; intent: ExecutionIntent; ledger: LedgerState };

const DEFAULT_TTL_MS = 60_000;

/** Egy szándék végrehajtása a közös kapun és a közös könyvelőn keresztül. */
export async function executeIntent(
  request: IntentRequest,
  deps: ExecuteIntentDeps,
): Promise<ExecuteIntentOutcome> {
  const riskParams = deps.riskParams ?? DEFAULT_ORDER_RISK_PARAMS;
  const ctx = deps.getRiskContext();

  const verdict = evaluateOrder(
    request.side === "BUY"
      ? { side: "BUY", symbol: request.symbol, desiredQuote: request.desiredQuote ?? ZERO }
      : { side: "SELL", symbol: request.symbol, baseQty: request.baseQty ?? ZERO },
    ctx,
    riskParams,
  );

  if (!verdict.allowed) {
    return { status: "rejected_by_risk", code: verdict.code, reasons: verdict.reasons, ledger: deps.getLedger() };
  }

  const now = deps.now();
  const intent: ExecutionIntent = {
    intentId: deps.newIntentId(),
    portfolioId: deps.portfolioId,
    mode: deps.mode,
    strategyVersion: deps.strategyVersion,
    origin: request.origin,
    expiresAt: now + (deps.intentTtlMs ?? DEFAULT_TTL_MS),
    contractVersion: EXECUTION_CONTRACT_VERSION,
    referencePrice: request.referencePrice,
    order: verdict.order,
  };

  const reservedQuote = verdict.order.side === "BUY" ? verdict.order.maxQuoteSpend : ZERO;
  if (deps.reserve) {
    const ok = await deps.reserve(intent, reservedQuote);
    if (!ok) {
      await deps.recordIntent?.(intent, null);
      return { status: "not_reserved", intent, ledger: deps.getLedger() };
    }
  }

  let receipt: ExecutionReceipt;
  try {
    receipt = await deps.broker.submit(intent);
  } catch (e) {
    // A beküldés kimenetele ISMERETLEN: nem küldünk új azonosítójú ordert, egyeztetés jön.
    await deps.recordIntent?.(intent, null);
    return { status: "unknown", intent, message: String(e), ledger: deps.getLedger() };
  }

  await deps.recordIntent?.(intent, receipt);

  if (receipt.state === "unknown") {
    return {
      status: "unknown",
      intent,
      message: receipt.error?.message ?? "Ismeretlen order-állapot — egyeztetés szükséges.",
      ledger: deps.getLedger(),
    };
  }

  if (receipt.fills.length === 0) {
    if (deps.releaseReservation) await deps.releaseReservation(intent);
    return {
      status: "rejected_by_broker",
      intent,
      code: receipt.error?.code ?? receipt.state,
      message: receipt.error?.message ?? `A megbízás nem teljesült (${receipt.state}).`,
      ledger: deps.getLedger(),
    };
  }

  // Könyvelés a KÖZÖS ledgerrel. A perzisztencia hibája NEM néma: kifelé dobjuk.
  let ledger = deps.getLedger();
  const booked: Fill[] = [];
  let consumed: Dec = ZERO;
  for (const fill of receipt.fills) {
    const result = applyFill(ledger, fill, {
      quoteAsset: ctx.quoteAsset,
      // Csak explicit kérésre írjuk felül a stopot; egyébként a meglévő marad.
      ...(request.stopPrice !== undefined ? { stopPrice: request.stopPrice } : {}),
    });
    if (!result.applied) {
      // Duplikátum: már könyveltük. Bármi más valódi könyvelési hiba.
      if (result.error?.code === "duplicate_fill") continue;
      throw new Error(`[execute-intent] a fill nem könyvelhető: ${result.error?.code} ${result.error?.message}`);
    }
    if (deps.persist) {
      const deltas =
        intent.order.side === "BUY"
          ? withReservation(result.deltas!, intent.intentId, fill.grossQuoteAmount)
          : result.deltas!;
      await deps.persist(intent, fill, deltas);
    }
    ledger = result.state;
    booked.push(fill);
    consumed = add(consumed, fill.grossQuoteAmount);
  }

  // Részleges teljesülés: a maradék foglalást elengedjük, hogy ne kösse le a keretet.
  if (deps.releaseReservation && receipt.state !== "filled") {
    await deps.releaseReservation(intent);
  }

  return { status: "executed", intent, fills: booked, ledger, reasons: verdict.reasons };
}

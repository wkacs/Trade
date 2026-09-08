import type { Order, Trade } from "@/lib/types";
import type { Broker, ExecutionBroker, ExecutionReceipt } from "./broker";
import {
  clientOrderId,
  fillKey,
  isIntentExpired,
  type ExecutionIntent,
  type Fill,
} from "./contracts";
import {
  simulatePaperFill,
  DEFAULT_PAPER_FILL_PARAMS,
  type ObservedMarket,
  type PaperFillKind,
  type PaperFillParams,
} from "./paper-fill";
import { type Dec, gt, gte, isPositive, min as decMin, ZERO } from "@/lib/portfolio/money";
import type { LedgerState } from "@/lib/portfolio/ledger";
import { cashOf, positionQty } from "@/lib/portfolio/ledger";

const PAPER_FEE_PCT = 0.001; // 0.1% szimulált díj

interface PaperState {
  cashUsd: number;
  positions: { symbol: string; qty: number; valueUsd: number }[];
}

/**
 * PaperBroker (v1) — demo módban, valós áron szimulál tranzakciót.
 *
 * @deprecated A v2 út a `PaperExecutionBroker`. Ez az osztály csak addig marad, amíg a
 * runTick át nem áll a közös végrehajtási útra (T06); saját, párhuzamos egyenleget vezet,
 * ami pontosan az audit §3 által kimutatott drift forrása.
 */
export class PaperBroker implements Broker {
  constructor(private state: PaperState) {}

  async execute(order: Order, currentPrice: number): Promise<Trade> {
    const gross =
      order.side === "BUY"
        ? Math.min(order.amountUsd, Math.max(0, this.state.cashUsd))
        : order.amountUsd;
    const feeUsd = gross * PAPER_FEE_PCT;
    const netUsd = gross - feeUsd;
    const qty = netUsd / currentPrice;

    if (order.side === "BUY") {
      this.state.cashUsd -= gross;
      const existing = this.state.positions.find((p) => p.symbol === order.symbol);
      if (existing) {
        existing.qty += qty;
        existing.valueUsd += netUsd;
      } else {
        this.state.positions.push({ symbol: order.symbol, qty, valueUsd: netUsd });
      }
    } else {
      this.state.cashUsd += gross;
      const existing = this.state.positions.find((p) => p.symbol === order.symbol);
      if (existing) {
        existing.qty -= qty;
        existing.valueUsd -= netUsd;
        if (existing.qty <= 0.0000001) {
          this.state.positions = this.state.positions.filter((p) => p.symbol !== order.symbol);
        }
      }
    }

    return {
      id: crypto.randomUUID(),
      orderId: crypto.randomUUID(),
      symbol: order.symbol,
      side: order.side,
      amountUsd: gross,
      price: currentPrice,
      qty,
      feeUsd,
      executedAt: Date.now(),
      mode: "paper",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 — PaperExecutionBroker
// ─────────────────────────────────────────────────────────────────────────────

export interface PaperBrokerDeps {
  /** A KÖZÖS ledger aktuális állapota. A broker CSAK OLVASSA — nincs második egyenleg. */
  getLedger: () => LedgerState;
  /** A megfigyelt piaci állapot symbolonként (bid/ask/last). */
  getMarket: (symbol: string) => ObservedMarket | null;
  /** Injektált idő — a determinisztikus teszthez. */
  now: () => number;
  /** A trigger-fajta és -ár, ha az intent stop/TP eredetű. */
  getTrigger?: (intent: ExecutionIntent) => { kind: PaperFillKind; triggerPrice?: Dec } | null;
  params?: PaperFillParams;
  /**
   * Intentenkénti paraméter-felülírás. Azért kell, mert a VÉTEL és az ELADÁS nem ugyanazt
   * a lot-szabályt kapja: az új belépő konzervatív egész lotot, egy meglévő pozíció zárása
   * viszont a tényleges készletet követi (különben tört maradvány ragadna bent). Üresen a
   * `params` érvényes minden intentre — a régi viselkedés.
   */
  paramsFor?: (intent: ExecutionIntent) => PaperFillParams;
}

/**
 * PaperExecutionBroker (v2) — a közös szerződés szerint működő demo végrehajtás.
 *
 * Amit a v1-hez képest javít:
 *  - A SELL a BIRTOKOLT mennyiségből megy (baseQty), nem a készpénzből számolt USD-ből.
 *  - Nem vezet saját egyenleget: a fedezetet a KÖZÖS ledgerből olvassa, a könyvelést a
 *    hívó végzi a ledger reducerrel. Egy igazságforrás.
 *  - A stop-fill nem lehet kedvezőbb a megfigyelt árnál (95-ös stop, 90-es ár → 90).
 *  - Nem teljesíthető order esetén strukturált `rejected` állapot, nem nulla méretű trade.
 *  - Stabil, intentId-ból származó order-azonosító: az újraküldés nem duplikál.
 */
export class PaperExecutionBroker implements ExecutionBroker {
  /** Beküldött megbízások az intentId szerint — az újraküldés ugyanazt adja vissza. */
  private submitted = new Map<string, ExecutionReceipt>();

  constructor(private deps: PaperBrokerDeps) {}

  async submit(intent: ExecutionIntent): Promise<ExecutionReceipt> {
    const coid = clientOrderId(intent.intentId);
    const existing = this.submitted.get(intent.intentId);
    if (existing) return existing;

    const reject = (code: string, message: string): ExecutionReceipt => {
      const receipt: ExecutionReceipt = {
        exchangeOrderId: null,
        clientOrderId: coid,
        state: "rejected",
        fills: [],
        error: { code, message },
      };
      this.submitted.set(intent.intentId, receipt);
      return receipt;
    };

    if (isIntentExpired(intent, this.deps.now())) {
      return reject("intent_expired", `Az intent lejárt (${intent.expiresAt} < ${this.deps.now()})`);
    }

    const market = this.deps.getMarket(intent.order.symbol);
    if (!market) return reject("no_market_data", `Nincs piaci adat: ${intent.order.symbol}`);

    const ledger = this.deps.getLedger();
    const trigger = this.deps.getTrigger?.(intent) ?? null;
    const kind: PaperFillKind = trigger?.kind ?? "market";

    // Fedezet a KÖZÖS ledgerből — a broker nem tárol párhuzamos egyenleget.
    let maxQuoteSpend: Dec | undefined;
    let baseQty: Dec | undefined;
    if (intent.order.side === "BUY") {
      const available = cashOf(ledger, this.deps.params?.quoteAsset ?? "USDT");
      maxQuoteSpend = decMin(intent.order.maxQuoteSpend, available);
      if (!isPositive(maxQuoteSpend)) {
        return reject("insufficient_cash", `Nincs fedezet: ${available} elérhető`);
      }
    } else {
      const held = positionQty(ledger, intent.order.symbol);
      if (!isPositive(held)) {
        return reject("no_position", `Nem birtokolt coin eladása tiltott: ${intent.order.symbol}`);
      }
      baseQty = decMin(intent.order.baseQty, held);
      if (!isPositive(baseQty)) {
        return reject("zero_qty", `Nulla eladható mennyiség: ${intent.order.symbol}`);
      }
    }

    const sim = simulatePaperFill(
      {
        side: intent.order.side,
        kind,
        symbol: intent.order.symbol,
        maxQuoteSpend,
        baseQty,
        triggerPrice: trigger?.triggerPrice,
        market,
      },
      this.deps.paramsFor?.(intent) ?? this.deps.params ?? DEFAULT_PAPER_FILL_PARAMS,
    );
    if (!sim.ok) return reject(sim.reason, sim.message);

    const exchangeOrderId = `paper-${coid}`;
    const exchangeTradeId = `${exchangeOrderId}-1`;
    const fill: Fill = {
      fillId: fillKey(intent.mode, exchangeOrderId, exchangeTradeId),
      intentId: intent.intentId,
      portfolioId: intent.portfolioId,
      mode: intent.mode,
      symbol: intent.order.symbol,
      side: intent.order.side,
      exchangeOrderId,
      exchangeTradeId,
      filledBaseQty: sim.filledBaseQty,
      grossQuoteAmount: sim.grossQuoteAmount,
      fillPrice: sim.fillPrice,
      feeAmount: sim.feeAmount,
      feeAsset: sim.feeAsset,
      executedAt: this.deps.now(),
    };

    const receipt: ExecutionReceipt = {
      exchangeOrderId,
      clientOrderId: coid,
      state: "filled",
      fills: [fill],
    };
    this.submitted.set(intent.intentId, receipt);
    return receipt;
  }

  /** A paper végrehajtás azonnali: a lekérdezés a beküldéskori nyugtát adja vissza. */
  async lookup(intent: ExecutionIntent): Promise<ExecutionReceipt> {
    return (
      this.submitted.get(intent.intentId) ?? {
        exchangeOrderId: null,
        clientOrderId: clientOrderId(intent.intentId),
        state: "unknown",
        fills: [],
        error: { code: "not_found", message: "Ez az intent még nem lett beküldve" },
      }
    );
  }
}

/** Segéd: van-e a ledgerben elegendő fedezet ehhez az intenthez (tiszta ellenőrzés). */
export function hasCoverage(ledger: LedgerState, intent: ExecutionIntent, quoteAsset = "USDT"): boolean {
  if (intent.order.side === "BUY") return gt(cashOf(ledger, quoteAsset), ZERO);
  return gte(positionQty(ledger, intent.order.symbol), intent.order.baseQty);
}

import { createHmac, randomUUID } from "crypto";
import type { Order, Trade } from "@/lib/types";
import type { Broker, ExecutionBroker, ExecutionReceipt } from "./broker";
import { clientOrderId, fillKey, isIntentExpired, toLegacyOrder, type ExecutionIntent } from "./contracts";
import { dec, toNumber, isPositive } from "@/lib/portfolio/money";
import {
  interpretOrder,
  unknownFromError,
  type BinanceOrderPayload,
} from "./binance-order-state";
import {
  sizeBuy,
  sizeSell,
  protectionPrices,
  pairFor,
  type SymbolFilters,
} from "./exchange-rules";

const BINANCE_BASE = "https://api.binance.com";

interface BinanceFill {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
}
interface BinanceOrderResponse {
  orderId: number;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  fills?: BinanceFill[];
}

/**
 * BinanceBroker — valós Binance Spot piaci order. CSAK live módban, `read+trade`
 * kulccsal, SOHA `withdraw` joggal. Lásd spec §3.3 + §6.
 *
 * Működés: signed (HMAC-SHA256) MARKET order USD-összeggel (quoteOrderQty). BUY után
 * best-effort védő STOP_LOSS_LIMIT order a belépési ár alá (kötelező stop-loss, spec §3.4).
 * A Risk Manager limitjei már a broker ELŐTT érvényesülnek; itt a stop-loss minimumot
 * duplán is ellenőrizzük.
 *
 * ⚠️ ÉLESÍTÉS ELŐTT KÖTELEZŐ (valós pénz!):
 *  - Binance szimbólum-szűrők (LOT_SIZE stepSize, PRICE_FILTER tickSize, MIN_NOTIONAL):
 *    a mennyiség/ár pontosságot az exchangeInfo alapján kerekíteni kell, különben az
 *    order elutasítható. Itt egyszerű .toFixed() van — kis tőkénél (≈$5 order) a
 *    MIN_NOTIONAL ($5–10) is gondot okozhat. Validáld ELŐBB kézzel, pici összeggel.
 *  - API kulcs IP-whitelisttel, csak read+trade.
 *  - A DB-egyenleg (applyTrade) a valós Binance-számlát csak TÜKRÖZI; a tényleges
 *    igazságforrás a Binance — a reconciliation (egyenleg-szinkron) külön feladat.
 */
export class BinanceBroker implements Broker {
  constructor(
    private apiKey: string,
    private apiSecret: string,
    private recvWindow = 5000,
  ) {
    if (!apiKey || !apiSecret) throw new Error("BinanceBroker: hiányzó API kulcsok");
  }

  private sign(query: string): string {
    return createHmac("sha256", this.apiSecret).update(query).digest("hex");
  }

  private async signedRequest(
    path: string,
    params: Record<string, string | number>,
  ): Promise<unknown> {
    const query = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      timestamp: String(Date.now()),
      recvWindow: String(this.recvWindow),
    }).toString();
    const signature = this.sign(query);
    const res = await fetch(`${BINANCE_BASE}${path}?${query}&signature=${signature}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`Binance ${res.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  /**
   * A szimbólum aktuális szűrőkészlete. A hívó tölti fel (exchange-rules.fetchSymbolFilters);
   * hiánya esetén a broker NEM küld ordert — ismeretlen szabályokkal nem kereskedünk.
   */
  filters: Record<string, SymbolFilters> = {};

  async execute(order: Order, currentPrice: number): Promise<Trade> {
    const symbol = pairFor(order.symbol);
    const filters = this.filters[symbol];
    const now = Date.now();

    // T24: a kitalált „stop-loss min 5%" dobás helyett VALÓDI tőzsdei validáció.
    // A stop hiánya nem itt dől el (azt a stratégia és a védőorder-kezelés adja).
    const price = dec(currentPrice);
    const sized =
      order.side === "BUY"
        ? sizeBuy(dec(order.amountUsd), price, filters, now)
        : sizeSell(dec(order.amountUsd / (currentPrice || 1)), price, filters, now);
    if (!sized.check.ok) {
      throw new Error(
        `BinanceBroker: a tőzsdei szabályok elutasítják (${sized.check.reason}): ${sized.check.message}`,
      );
    }

    // MARKET BUY-nál a quoteOrderQty a természetes (a tőzsde kerekít), de a kerekítés
    // UTÁNI notionalt már ellenőriztük, ezért a minimum alatti order ide sem jut el.
    const params: Record<string, string> =
      order.side === "BUY"
        ? { symbol, side: "BUY", type: "MARKET", quoteOrderQty: sized.notional }
        : { symbol, side: "SELL", type: "MARKET", quantity: sized.qty };
    const resp = (await this.signedRequest("/api/v3/order", params)) as BinanceOrderResponse;

    const executedQty = Number(resp.executedQty);
    const quote = Number(resp.cummulativeQuoteQty);
    const avgPrice = executedQty > 0 ? quote / executedQty : currentPrice;
    const feeUsd = (resp.fills ?? []).reduce((s, f) => {
      const c = Number(f.commission);
      // A díj a commissionAsset-ben jön; ha nem USDT, az árral közelítjük.
      return s + (f.commissionAsset === "USDT" ? c : c * Number(f.price || avgPrice));
    }, 0);

    // BUY után védő stop-loss-limit (best-effort). Ha hibázik, HANGOSAN logolunk:
    // a pozíció ekkor stop NÉLKÜL nyitva maradt — ezt kézzel kell rendezni.
    if (order.side === "BUY" && executedQty > 0 && filters) {
      // A védőorder ára és mennyisége is a TŐZSDEI szűrőkre kerekül (tickSize/stepSize).
      const { stop, limit } = protectionPrices(dec(avgPrice * (1 - order.stopLossPct)), filters);
      const protectQty = sizeSell(dec(executedQty), stop, filters, now, "LIMIT");
      try {
        if (!protectQty.check.ok) {
          throw new Error(`a védőorder nem felel meg a szűrőknek: ${protectQty.check.message}`);
        }
        await this.signedRequest("/api/v3/order", {
          symbol,
          side: "SELL",
          type: "STOP_LOSS_LIMIT",
          quantity: protectQty.qty,
          stopPrice: stop,
          price: limit,
          timeInForce: "GTC",
        });
      } catch (e) {
        console.error(
          "[BinanceBroker] ⚠️ védő stop-loss order HIBA — a pozíció stop nélkül nyitva maradt:",
          e,
        );
      }
    }

    return {
      id: randomUUID(),
      orderId: String(resp.orderId),
      symbol: order.symbol,
      side: order.side,
      amountUsd: quote || order.amountUsd,
      price: avgPrice,
      qty: executedQty,
      feeUsd,
      executedAt: Date.now(),
      mode: "live",
    };
  }
}

/**
 * ÁTMENETI adapter: a v1 BinanceBrokert a v2 ExecutionBroker felületre húzza, hogy a live
 * mód is a KÖZÖS végrehajtási úton (execute-intent + risk gate + ledger) menjen.
 *
 * Korlátai — ezeket a T25 oldja meg: nincs stabil client order ID a tőzsdén, nincs
 * státusz-lekérdezés timeout után, és a részleges teljesülés sem különül el. Amíg ez az
 * adapter él, a live mód NEM tekinthető auditáltnak.
 */
export class BinanceLegacyExecutionAdapter implements ExecutionBroker {
  constructor(
    private broker: BinanceBroker,
    private stopLossPct: number,
    private now: () => number = () => Date.now(),
  ) {}

  async submit(intent: ExecutionIntent): Promise<ExecutionReceipt> {
    const coid = clientOrderId(intent.intentId);
    if (isIntentExpired(intent, this.now())) {
      return { exchangeOrderId: null, clientOrderId: coid, state: "rejected", fills: [], error: { code: "intent_expired", message: "Az intent lejárt" } };
    }
    const legacy = toLegacyOrder(intent.order, intent.referencePrice, this.stopLossPct);
    let trade: Trade;
    try {
      trade = await this.broker.execute(legacy, Number(intent.referencePrice));
    } catch (e) {
      // Ismeretlen kimenetel: a hívó egyeztetést indít, NEM küld új azonosítójú ordert.
      return { exchangeOrderId: null, clientOrderId: coid, state: "unknown", fills: [], error: { code: "submit_failed", message: String(e) } };
    }
    if (!(trade.qty > 0) || !(trade.amountUsd > 0)) {
      return { exchangeOrderId: trade.orderId ?? null, clientOrderId: coid, state: "rejected", fills: [], error: { code: "zero_fill", message: "A megbízás nem teljesült" } };
    }
    const exchangeTradeId = `${trade.orderId}-1`;
    return {
      exchangeOrderId: trade.orderId,
      clientOrderId: coid,
      state: "filled",
      fills: [
        {
          fillId: fillKey("live", trade.orderId, exchangeTradeId),
          intentId: intent.intentId,
          portfolioId: intent.portfolioId,
          mode: "live",
          symbol: trade.symbol,
          side: trade.side,
          exchangeOrderId: trade.orderId,
          exchangeTradeId,
          filledBaseQty: dec(trade.qty),
          grossQuoteAmount: dec(trade.amountUsd),
          fillPrice: dec(trade.price),
          feeAmount: dec(trade.feeUsd),
          feeAsset: "USDT",
          executedAt: trade.executedAt,
        },
      ],
    };
  }

  async lookup(intent: ExecutionIntent): Promise<ExecutionReceipt> {
    // A v1 broker nem tud állapotot lekérdezni — ezt a T25 pótolja.
    return {
      exchangeOrderId: null,
      clientOrderId: clientOrderId(intent.intentId),
      state: "unknown",
      fills: [],
      error: { code: "lookup_unsupported", message: "A v1 adapter nem tud order-állapotot lekérdezni (T25)" },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 — BinanceExecutionBroker (T25): stabil client order ID, státusz-lekérdezés,
// részleges teljesülés és díj a saját eszközében.
// ─────────────────────────────────────────────────────────────────────────────

export interface BinanceHttp {
  /** Aláírt POST. Timeout esetén DOBJON — a hívó ilyenkor lekérdez, nem küld újat. */
  signedPost(path: string, params: Record<string, string>): Promise<unknown>;
  /** Aláírt GET (order-állapot lekérdezés). */
  signedGet(path: string, params: Record<string, string>): Promise<unknown>;
}

export interface BinanceExecutionDeps {
  http: BinanceHttp;
  /** Szimbólum-szűrők (T24). Hiányuk esetén NINCS order. */
  filters: Record<string, SymbolFilters>;
  now: () => number;
  quoteAsset?: string;
}

/**
 * Valós Binance végrehajtás a v2 szerződéssel (T25).
 *
 * Garanciák:
 *  - STABIL `newClientOrderId` az intentId-ból → az újraküldés NEM hoz létre másodikat;
 *  - timeout után NEM küldünk új azonosítójú ordert, hanem LEKÉRDEZÜNK;
 *  - a részleges teljesülés `partially_filled`, a nulla fill `rejected` vagy `unknown`;
 *  - a díj a saját eszközében marad, a hiányzó díjárfolyam FÜGGŐ értékelés.
 */
export class BinanceExecutionBroker implements ExecutionBroker {
  /** Azok a fill-ek, ahol a díj eszközének USD-értékelése függőben van. */
  pendingFeeValuations: { fillId: string; asset: string; amount: string }[] = [];

  constructor(private deps: BinanceExecutionDeps) {}

  private pairOf(symbol: string): string {
    return pairFor(symbol, this.deps.quoteAsset ?? "USDT");
  }

  async submit(intent: ExecutionIntent): Promise<ExecutionReceipt> {
    const coid = clientOrderId(intent.intentId);
    const pair = this.pairOf(intent.order.symbol);
    const filters = this.deps.filters[pair];
    const now = this.deps.now();

    if (isIntentExpired(intent, now)) {
      return {
        exchangeOrderId: null,
        clientOrderId: coid,
        state: "rejected",
        fills: [],
        error: { code: "intent_expired", message: "Az intent lejárt — nem küldünk ordert." },
      };
    }

    // T24: a tőzsdei szabályok ELŐBB. Ismeretlen vagy elavult szűrő → nincs order.
    const sized =
      intent.order.side === "BUY"
        ? sizeBuy(intent.order.maxQuoteSpend, intent.referencePrice, filters, now)
        : sizeSell(intent.order.baseQty, intent.referencePrice, filters, now);
    if (!sized.check.ok) {
      return {
        exchangeOrderId: null,
        clientOrderId: coid,
        state: "rejected",
        fills: [],
        error: { code: sized.check.reason ?? "rule_violation", message: sized.check.message ?? "" },
      };
    }

    const params: Record<string, string> =
      intent.order.side === "BUY"
        ? { symbol: pair, side: "BUY", type: "MARKET", quoteOrderQty: sized.notional, newClientOrderId: coid, newOrderRespType: "FULL" }
        : { symbol: pair, side: "SELL", type: "MARKET", quantity: sized.qty, newClientOrderId: coid, newOrderRespType: "FULL" };

    let payload: unknown;
    try {
      payload = await this.deps.http.signedPost("/api/v3/order", params);
    } catch (e) {
      // A kimenetel ISMERETLEN. NEM küldünk új azonosítójú ordert — lekérdezünk.
      const message = e instanceof Error ? e.message : String(e);
      if (/duplicate|-2010|already/i.test(message)) {
        // A tőzsde szerint ez a client order ID már létezik → a mi ordereünk. Lekérdezzük.
        return this.lookup(intent);
      }
      const unknown = unknownFromError(e);
      return {
        exchangeOrderId: null,
        clientOrderId: coid,
        state: "unknown",
        fills: [],
        error: { code: "submit_unknown", message: unknown.message ?? message },
      };
    }

    return this.toReceipt(intent, coid, payload as BinanceOrderPayload, filters);
  }

  /** Egy korábbi (esetleg ismeretlen állapotú) megbízás lekérdezése a STABIL azonosítóval. */
  async lookup(intent: ExecutionIntent): Promise<ExecutionReceipt> {
    const coid = clientOrderId(intent.intentId);
    const pair = this.pairOf(intent.order.symbol);
    try {
      const payload = (await this.deps.http.signedGet("/api/v3/order", {
        symbol: pair,
        origClientOrderId: coid,
      })) as BinanceOrderPayload;
      return this.toReceipt(intent, coid, payload, this.deps.filters[pair]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // -2013: "Order does not exist" → a megbízás sosem jött létre, tehát nem teljesült.
      if (/-2013|does not exist/i.test(message)) {
        return {
          exchangeOrderId: null,
          clientOrderId: coid,
          state: "rejected",
          fills: [],
          error: { code: "order_not_found", message: "A tőzsde szerint nem jött létre megbízás ezzel az azonosítóval." },
        };
      }
      return {
        exchangeOrderId: null,
        clientOrderId: coid,
        state: "unknown",
        fills: [],
        error: { code: "lookup_failed", message },
      };
    }
  }

  private toReceipt(
    intent: ExecutionIntent,
    coid: string,
    payload: BinanceOrderPayload,
    filters: SymbolFilters | undefined,
  ): ExecutionReceipt {
    const interpreted = interpretOrder(payload, intent, {
      quoteAsset: this.deps.quoteAsset ?? "USDT",
      baseAsset: filters?.baseAsset ?? intent.order.symbol,
    });
    for (const p of interpreted.pendingFeeValuations) {
      this.pendingFeeValuations.push({ fillId: p.fillId, asset: p.asset, amount: p.amount });
    }
    // Nulla fill NEM siker: a `rejected`/`unknown` állapotot az interpretOrder adja.
    const noFills = interpreted.fills.length === 0;
    return {
      exchangeOrderId: interpreted.exchangeOrderId,
      clientOrderId: coid,
      state: interpreted.state,
      fills: interpreted.fills,
      error:
        interpreted.message || (noFills && interpreted.state !== "pending")
          ? { code: interpreted.state, message: interpreted.message ?? "Nem érkezett teljesülés." }
          : undefined,
    };
  }
}

import { createHmac, randomUUID } from "crypto";
import type { Order, Trade } from "@/lib/types";
import type { Broker, ExecutionBroker, ExecutionReceipt } from "./broker";
import { clientOrderId, fillKey, isIntentExpired, toLegacyOrder, type ExecutionIntent } from "./contracts";
import { dec, toNumber, isPositive } from "@/lib/portfolio/money";
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

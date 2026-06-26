import { createHmac, randomUUID } from "crypto";
import type { Order, Trade } from "@/lib/types";
import type { Broker } from "./broker";

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

  async execute(order: Order, currentPrice: number): Promise<Trade> {
    // Kötelező stop-loss (spec §3.4/§6) — dupla biztosíték a Risk Manager felett.
    if (order.stopLossPct < 0.05) {
      throw new Error("BinanceBroker: stop-loss kötelező, min 5%");
    }

    const symbol = `${order.symbol}USDT`;
    const resp = (await this.signedRequest("/api/v3/order", {
      symbol,
      side: order.side,
      type: "MARKET",
      quoteOrderQty: order.amountUsd.toFixed(2),
    })) as BinanceOrderResponse;

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
    if (order.side === "BUY" && executedQty > 0) {
      const stopPrice = avgPrice * (1 - order.stopLossPct);
      try {
        await this.signedRequest("/api/v3/order", {
          symbol,
          side: "SELL",
          type: "STOP_LOSS_LIMIT",
          quantity: executedQty.toString(),
          stopPrice: stopPrice.toFixed(2),
          price: (stopPrice * 0.999).toFixed(2),
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

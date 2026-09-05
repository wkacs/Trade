import { createHmac } from "crypto";
import type { BinanceHttp } from "./binance-broker";
import type { ExchangeSnapshot, ExchangeOpenOrder } from "./reconcile";
import type { ExecutionOutcome, ProtectionAction, ProtectionOrder } from "./protection";
import { dec } from "@/lib/portfolio/money";
import { pairFor } from "./exchange-rules";

const BASE = "https://api.binance.com";

/** Egyetlen, időkorlátos és aláírt Binance Spot kliens a live brokerhez és az egyeztetéshez. */
export class BinanceLiveClient implements BinanceHttp {
  constructor(
    private apiKey: string,
    private apiSecret: string,
    private timeoutMs = 8_000,
    private recvWindow = 5_000,
  ) {
    if (!apiKey || !apiSecret) throw new Error("Hiányzó BINANCE_API_KEY/BINANCE_API_SECRET.");
  }

  private async request(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string>) {
    const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: String(this.recvWindow) }).toString();
    const signature = createHmac("sha256", this.apiSecret).update(query).digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${BASE}${path}?${query}&signature=${signature}`, {
        method,
        headers: { "X-MBX-APIKEY": this.apiKey },
        signal: controller.signal,
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`Binance ${response.status}: ${JSON.stringify(body)}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  signedPost(path: string, params: Record<string, string>) { return this.request("POST", path, params); }
  signedGet(path: string, params: Record<string, string>) { return this.request("GET", path, params); }
  signedDelete(path: string, params: Record<string, string>) { return this.request("DELETE", path, params); }

  async snapshot(symbols: string[], quoteAsset = "USDT"): Promise<ExchangeSnapshot> {
    const pairs = symbols.map((s) => pairFor(s, quoteAsset));
    const [accountRaw, ordersRaw, ...tradesRaw] = await Promise.all([
      this.signedGet("/api/v3/account", { omitZeroBalances: "false" }),
      this.signedGet("/api/v3/openOrders", {}),
      ...pairs.map((symbol) => this.signedGet("/api/v3/myTrades", { symbol, limit: "1000" })),
    ]);
    const account = accountRaw as { balances?: { asset: string; free: string; locked: string }[] };
    const orders = Array.isArray(ordersRaw) ? ordersRaw as Record<string, unknown>[] : [];
    return {
      balances: (account.balances ?? []).map((b) => ({ asset: b.asset, free: dec(b.free), locked: dec(b.locked) })),
      openOrders: orders.map((o): ExchangeOpenOrder => ({
        symbol: String(o.symbol), orderId: String(o.orderId), clientOrderId: String(o.clientOrderId ?? ""),
        side: String(o.side) === "BUY" ? "BUY" : "SELL", type: String(o.type),
        origQty: dec(String(o.origQty ?? "0")), executedQty: dec(String(o.executedQty ?? "0")),
        price: dec(String(o.price ?? "0")), stopPrice: o.stopPrice == null ? null : dec(String(o.stopPrice)),
        status: String(o.status ?? "NEW"),
      })),
      trades: Object.fromEntries(pairs.map((pair, i) => [pair.slice(0, -quoteAsset.length), Array.isArray(tradesRaw[i]) ? tradesRaw[i] : []])),
      fetchedAt: Date.now(),
    };
  }

  protectionFrom(snapshot: ExchangeSnapshot, quoteAsset = "USDT"): Record<string, ProtectionOrder | undefined> {
    return Object.fromEntries(snapshot.openOrders.filter((o) => o.side === "SELL" && /STOP/i.test(o.type)).map((o) => {
      const symbol = o.symbol.endsWith(quoteAsset) ? o.symbol.slice(0, -quoteAsset.length) : o.symbol;
      return [symbol, { symbol, exchangeOrderId: o.orderId, clientOrderId: o.clientOrderId,
        qty: dec(Number(o.origQty) - Number(o.executedQty)), stopPrice: o.stopPrice ?? "0", limitPrice: o.price,
        state: "pending" as const, placedAt: snapshot.fetchedAt }];
    }));
  }

  async executeProtection(actions: ProtectionAction[], quoteAsset = "USDT"): Promise<ExecutionOutcome[]> {
    const outcomes: ExecutionOutcome[] = [];
    for (const action of actions) {
      try {
        const symbol = pairFor(action.symbol, quoteAsset);
        if (action.kind === "cancel" || action.kind === "replace") {
          const canceled = await this.signedDelete("/api/v3/order", { symbol, orderId: String(action.cancelOrderId) }) as { status?: string };
          if (canceled.status === "FILLED") {
            outcomes.push({ action, ok: true, filledDuringReplace: true });
            continue;
          }
        }
        let newOrderId: string | undefined;
        if (action.kind === "place" || action.kind === "replace") {
          const placed = await this.signedPost("/api/v3/order", {
            symbol, side: "SELL", type: "STOP_LOSS_LIMIT", quantity: String(action.qty),
            stopPrice: String(action.stopPrice), price: String(action.limitPrice), timeInForce: "GTC",
          }) as { orderId?: string | number };
          newOrderId = placed.orderId == null ? undefined : String(placed.orderId);
        }
        outcomes.push({ action, ok: true, newOrderId });
      } catch (error) {
        outcomes.push({ action, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  }
}

/**
 * Tőzsdei egyenleg- és order-egyeztetés (T27).
 *
 * ALAPSZABÁLY: LIVE számlán a TŐZSDE az igazságforrás. A helyi ledger a tükör, nem
 * fordítva. Ha eltérés van, azt nem „elsimítjuk", hanem jelentjük, és amíg fennáll,
 * ÚJ VÉTEL TILOS — egy ismeretlen eredetű készlet vagy egy kézi tőzsdei kötés mellett
 * nem szabad tovább kockáztatni.
 *
 * A PAPER számlát ez a modul SOHA nem érinti: ott nincs tőzsdei igazságforrás.
 *
 * Tiszta függvények: nincs IO, nincs Date.now.
 */
import { type Dec, ZERO, add, sub, abs, gt, gte, lt, isPositive, dec } from "@/lib/portfolio/money";
import { fillKey, type Fill, type TradingMode } from "./contracts";
import type { LedgerState } from "@/lib/portfolio/ledger";
import { cashOf, positionQty } from "@/lib/portfolio/ledger";
import { mapFills, type BinanceOrderPayload, type BinanceTradePayload } from "./binance-order-state";
import type { ProtectionOrder } from "./protection";

export interface ExchangeBalance {
  asset: string;
  free: Dec;
  locked: Dec;
}

export interface ExchangeOpenOrder {
  symbol: string;
  orderId: string;
  clientOrderId: string;
  side: "BUY" | "SELL";
  type: string;
  origQty: Dec;
  executedQty: Dec;
  price: Dec;
  stopPrice: Dec | null;
  status: string;
}

export interface ExchangeSnapshot {
  balances: ExchangeBalance[];
  openOrders: ExchangeOpenOrder[];
  /** A legutóbbi teljesülések symbolonként (myTrades). */
  trades: Record<string, BinanceTradePayload[]>;
  fetchedAt: number;
}

export type DiscrepancyCode =
  | "balance_mismatch"
  | "position_mismatch"
  | "unknown_open_order"
  | "missing_protection"
  | "unimported_trade"
  | "paper_scope";

export interface Discrepancy {
  code: DiscrepancyCode;
  asset?: string;
  symbol?: string;
  /** A helyi nyilvántartás szerinti érték. */
  local: Dec | null;
  /** A tőzsde szerinti érték. */
  exchange: Dec | null;
  message: string;
  /** Igaz, ha emiatt ÚJ VÉTEL TILOS. */
  blocksNewBuys: boolean;
}

export interface ReconcileOptions {
  quoteAsset?: string;
  /** Mennyiség-eltérés tűréshatára (kerekítési zaj). */
  tolerance?: Dec;
  /** A már elkönyvelt fill-kulcsok — az ismételt import ellen. */
  knownFillIds?: string[];
  /** Az intent, amihez a talált teljesüléseket kötjük (a kézi kötésnek nincs ilyen). */
  intentIdForOrder?: Record<string, string>;
}

export interface ReconcileResult {
  discrepancies: Discrepancy[];
  /** Az MÉG NEM könyvelt teljesülések — pontosan egyszer importálandók. */
  newFills: Fill[];
  /** A tőzsdén ülő védőorderek (a T26 tervezőjének bemenete). */
  protection: Record<string, ProtectionOrder | undefined>;
  blockNewBuys: boolean;
  /** Igaz, ha a pillanatkép egyáltalán felhasználható. */
  usable: boolean;
}

const DEFAULT_TOLERANCE: Dec = "0.00000001";

/**
 * Egyeztetés. LIVE módban a tőzsde az igazságforrás; paper módban a modul NEM fut le,
 * és ezt explicit jelzi (a paper számla érintetlen marad).
 */
export function reconcile(
  local: LedgerState,
  exchange: ExchangeSnapshot,
  mode: TradingMode,
  options: ReconcileOptions = {},
): ReconcileResult {
  const quoteAsset = options.quoteAsset ?? "USDT";
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const known = new Set(options.knownFillIds ?? []);
  const discrepancies: Discrepancy[] = [];

  if (mode !== "live") {
    return {
      discrepancies: [
        {
          code: "paper_scope",
          local: null,
          exchange: null,
          message: "Paper számlán nincs tőzsdei igazságforrás — az egyeztetés nem fut le.",
          blocksNewBuys: false,
        },
      ],
      newFills: [],
      protection: {},
      blockNewBuys: false,
      usable: false,
    };
  }

  const balanceOf = (asset: string): ExchangeBalance | undefined => exchange.balances.find((b) => b.asset === asset);

  // 1) Quote-egyenleg: a helyi készpénz a tőzsdei free + locked összegével vetendő össze.
  const quoteBalance = balanceOf(quoteAsset);
  const localCash = cashOf(local, quoteAsset);
  if (!quoteBalance) {
    discrepancies.push({
      code: "balance_mismatch",
      asset: quoteAsset,
      local: localCash,
      exchange: null,
      message: `A tőzsdei pillanatképben nincs ${quoteAsset} egyenleg.`,
      blocksNewBuys: true,
    });
  } else {
    const exchangeTotal = add(quoteBalance.free, quoteBalance.locked);
    if (gt(abs(sub(exchangeTotal, localCash)), tolerance)) {
      discrepancies.push({
        code: "balance_mismatch",
        asset: quoteAsset,
        local: localCash,
        exchange: exchangeTotal,
        message: `A ${quoteAsset} egyenleg eltér: helyi ${localCash}, tőzsdei ${exchangeTotal} (free ${quoteBalance.free} + locked ${quoteBalance.locked}).`,
        blocksNewBuys: true,
      });
    }
  }

  // 2) Pozíciók: a base eszköz free + locked összege a helyi mennyiséggel.
  const symbols = new Set<string>([
    ...Object.keys(local.positions),
    ...exchange.balances.filter((b) => b.asset !== quoteAsset && isPositive(add(b.free, b.locked))).map((b) => b.asset),
  ]);
  for (const symbol of symbols) {
    const localQty = positionQty(local, symbol);
    const bal = balanceOf(symbol);
    const exchangeQty = bal ? add(bal.free, bal.locked) : ZERO;
    if (gt(abs(sub(exchangeQty, localQty)), tolerance)) {
      discrepancies.push({
        code: "position_mismatch",
        symbol,
        local: localQty,
        exchange: exchangeQty,
        message:
          `A ${symbol} készlet eltér: helyi ${localQty}, tőzsdei ${exchangeQty}. ` +
          "Ok lehet kézi tőzsdei kötés, kimaradás alatti stop-fill vagy be- és kifizetés.",
        blocksNewBuys: true,
      });
    }
  }

  // 3) Nyitott orderek: a védőordereket felismerjük, minden mást ISMERETLENKÉNT jelölünk.
  const protection: Record<string, ProtectionOrder | undefined> = {};
  for (const o of exchange.openOrders) {
    const base = o.symbol.endsWith(quoteAsset) ? o.symbol.slice(0, -quoteAsset.length) : o.symbol;
    const isProtection = o.side === "SELL" && /STOP/i.test(o.type);
    if (isProtection) {
      protection[base] = {
        symbol: base,
        exchangeOrderId: o.orderId,
        clientOrderId: o.clientOrderId,
        qty: sub(o.origQty, o.executedQty),
        stopPrice: o.stopPrice ?? ZERO,
        limitPrice: o.price,
        state: "pending",
        placedAt: exchange.fetchedAt,
      };
      continue;
    }
    discrepancies.push({
      code: "unknown_open_order",
      symbol: base,
      local: null,
      exchange: o.origQty,
      message: `Ismeretlen nyitott order a tőzsdén: ${o.symbol} ${o.side} ${o.type} (${o.orderId}). Kézi beavatkozás lehet.`,
      blocksNewBuys: true,
    });
  }

  // 4) Védelem nélküli nyitott pozíció.
  for (const symbol of Object.keys(local.positions)) {
    if (!isPositive(positionQty(local, symbol))) continue;
    if (!protection[symbol]) {
      discrepancies.push({
        code: "missing_protection",
        symbol,
        local: positionQty(local, symbol),
        exchange: ZERO,
        message: `A ${symbol} pozícióhoz nincs védőorder a tőzsdén.`,
        blocksNewBuys: true,
      });
    }
  }

  // 5) Még nem importált teljesülések — pontosan egyszer.
  const newFills: Fill[] = [];
  for (const [symbol, trades] of Object.entries(exchange.trades)) {
    for (const t of trades) {
      const orderId = t.orderId !== undefined ? String(t.orderId) : null;
      const tradeId = t.tradeId !== undefined ? String(t.tradeId) : t.id !== undefined ? String(t.id) : null;
      if (!orderId || !tradeId) continue;
      const key = fillKey("live", orderId, tradeId);
      if (known.has(key)) continue;

      const intentId = options.intentIdForOrder?.[orderId];
      const mapped = mapFills(
        { orderId, status: "FILLED", fills: [t] } as BinanceOrderPayload,
        {
          intentId: intentId ?? `manual:${orderId}`,
          portfolioId: local.portfolioId,
          mode: "live",
          strategyVersion: "reconcile",
          origin: intentId ? "ai" : "manual",
          expiresAt: exchange.fetchedAt,
          contractVersion: 2,
          referencePrice: t.price ? dec(t.price) : "1",
          order:
            t.isBuyer === false
              ? { side: "SELL", symbol, baseQty: t.qty ? dec(t.qty) : "1" }
              : { side: "BUY", symbol, maxQuoteSpend: t.quoteQty ? dec(t.quoteQty) : "1" },
        },
        { quoteAsset, baseAsset: symbol },
      );
      for (const f of mapped.fills) {
        newFills.push(f);
        if (!intentId) {
          discrepancies.push({
            code: "unimported_trade",
            symbol,
            local: null,
            exchange: f.filledBaseQty,
            message: `Nem a bot által indított teljesülés: ${symbol} ${f.side} ${f.filledBaseQty} (order ${orderId}).`,
            blocksNewBuys: true,
          });
        }
      }
    }
  }

  const blockNewBuys = discrepancies.some((d) => d.blocksNewBuys);
  return { discrepancies, newFills, protection, blockNewBuys, usable: true };
}

/** Igaz, ha a pillanatkép alapján biztonságos új vételt indítani. */
export function reconcileGate(result: ReconcileResult): { allowNewBuys: boolean; blocking: Discrepancy[] } {
  const blocking = result.discrepancies.filter((d) => d.blocksNewBuys);
  return { allowNewBuys: result.usable && blocking.length === 0, blocking };
}

/** Emberi olvasásra szánt összefoglaló az egyeztetésről. */
export function formatReconcile(result: ReconcileResult): string {
  if (!result.usable) return result.discrepancies[0]?.message ?? "Az egyeztetés nem futott le.";
  const lines = [
    `Eltérések: ${result.discrepancies.length}`,
    `Importálandó teljesülés: ${result.newFills.length}`,
    `Védőorder a tőzsdén: ${Object.keys(result.protection).length}`,
    result.blockNewBuys ? "ÚJ VÉTEL TILOS, amíg az eltérések fennállnak." : "Nincs blokkoló eltérés.",
  ];
  for (const d of result.discrepancies) lines.push(`  - [${d.code}] ${d.message}`);
  return lines.join("\n");
}

/**
 * A pillanatkép frissessége. Az egyeztetés elavult adaton félrevezető, ezért a hívó
 * ellenőrzi, mielőtt döntést hozna belőle.
 */
export function isSnapshotFresh(snapshot: ExchangeSnapshot, nowMs: number, maxAgeMs = 60_000): boolean {
  return nowMs - snapshot.fetchedAt <= maxAgeMs;
}

export { gte, lt };

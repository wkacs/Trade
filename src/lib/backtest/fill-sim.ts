import type { Candle } from "./types";

/**
 * Backtest fill-modell (T17).
 *
 * KÉT KÜLÖN VÉGREHAJTÁSI MÓD, mert nem ugyanaz a valóság:
 *
 *  - `polling`: a bot időnként ránéz az árra, és MARKET ordert küld. Csak azt látja, ami
 *    az ellenőrzés pillanatában látszik; a gyertyán belüli mélypontot NEM. A jel a
 *    LEZÁRT gyertyából születik, a teljesülés a KÖVETKEZŐ elérhető áron (a következő
 *    gyertya nyitóján). Ez a futó bot valósága.
 *
 *  - `exchange-stop`: a védőorder OTT ÜL a tőzsdén, ezért a gyertyán belül is tüzel.
 *    Gap esetén a nyitó ár a rosszabb, és a stop azon tölt.
 *
 * Az audit §7 pontosan ezt a keveredést kifogásolta: a régi backtest a teljes gyertya
 * high/low-jára reagált, miközben a futó bot óránként EGY pillanatképet lát.
 */

export type ExecutionModel = "polling" | "exchange-stop";

export interface FillRequest {
  side: "BUY" | "SELL";
  kind: "stop-loss" | "take-profit" | "market";
  /** Melyik végrehajtási mód szerint töltünk. */
  model: ExecutionModel;
  qty?: number; // SELL-hez (stop/TP/market-SELL)
  amountUsd?: number; // BUY market-hez (USD-összeg, díjjal együtt)
  triggerPrice?: number; // stop/TP referencia-ár
  candle: Candle;
  /**
   * Melyik árra tölt a market order. `open` = a KÖVETKEZŐ gyertya nyitója (nincs
   * look-ahead), `close` = ugyanezen gyertya zárója (csak a polling-ellenőrzés
   * pillanatának modellezésére).
   */
  at?: "open" | "close";
}

export interface SimFill {
  fillPrice: number;
  qty: number;
  amountUsd: number; // bruttó (qty * fillPrice)
  feeUsd: number;
}

/**
 * Egy order kitöltési árát számolja a gyertyából (a tüzelés tényét a hívó dönti el).
 *
 *  polling + market      : a megadott ár (`at`) ± slippage
 *  polling + stop/TP     : min(trigger, megfigyelt ár) − slippage
 *                          (a trigger sosem tehet jobbá egy rosszabb megfigyelést)
 *  exchange-stop + stop  : min(trigger, open) − slippage (gap-down a rosszabb nyitón tölt)
 *  exchange-stop + TP    : max(trigger, open) − slippage (a pihenő limit gap-upon jobban tölt)
 *
 * BUY-nál a díj BELEFÉR az `amountUsd` keretbe: bruttó = amountUsd / (1 + feePct).
 * Tiszta — nincs IO, nincs Date.now.
 */
export function simulateFill(req: FillRequest, feePct: number, slippageBps: number): SimFill | null {
  const slip = slippageBps / 10000;
  const c = req.candle;
  const marketPrice = req.at === "close" ? c.close : c.open;

  if (req.kind === "market" && req.side === "BUY") {
    const budget = req.amountUsd ?? 0;
    if (budget <= 0) return null;
    const fillPrice = marketPrice * (1 + slip);
    if (!(fillPrice > 0)) return null;
    const amountUsd = budget / (1 + feePct);
    const feeUsd = amountUsd * feePct;
    const qty = amountUsd / fillPrice;
    if (qty <= 0) return null;
    return { fillPrice, qty, amountUsd, feeUsd };
  }

  const qty = req.qty ?? 0;
  if (qty <= 0) return null;

  let base: number;
  if (req.kind === "market") {
    base = marketPrice;
  } else if (req.model === "exchange-stop") {
    base = req.kind === "stop-loss" ? Math.min(req.triggerPrice!, c.open) : Math.max(req.triggerPrice!, c.open);
  } else {
    // polling: a MEGFIGYELT ár a valóság; a trigger csak felső korlát.
    base = Math.min(req.triggerPrice!, marketPrice);
  }
  const fillPrice = base * (1 - slip);
  if (!(fillPrice > 0)) return null;
  const gross = qty * fillPrice;
  const feeUsd = gross * feePct;
  return { fillPrice, qty, amountUsd: gross, feeUsd };
}

/**
 * Tüzel-e a védőorder ebben a gyertyában?
 *
 * `exchange-stop` módban a gyertya LOW/HIGH dönt (a pihenő order intra-candle tüzel).
 * `polling` módban CSAK az ellenőrzés pillanatának ára (a gyertya zárója) számít — a
 * bot a mélypontot nem látta.
 *
 * Ugyanazon a gyertyán a STOP élvez elsőbbséget (konzervatív).
 */
export function protectionTriggers(
  candle: Candle,
  stopPrice: number | null,
  takeProfitPrice: number | null,
  model: ExecutionModel,
): "stop-loss" | "take-profit" | null {
  const low = model === "exchange-stop" ? candle.low : candle.close;
  const high = model === "exchange-stop" ? candle.high : candle.close;
  if (stopPrice !== null && stopPrice > 0 && low <= stopPrice) return "stop-loss";
  if (takeProfitPrice !== null && takeProfitPrice > 0 && high >= takeProfitPrice) return "take-profit";
  return null;
}

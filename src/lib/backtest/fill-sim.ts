import type { Candle } from "./types";

export interface FillRequest {
  side: "BUY" | "SELL";
  kind: "stop-loss" | "take-profit" | "market";
  qty?: number; // SELL-hez (stop/TP/market-SELL)
  amountUsd?: number; // BUY market-hez (USD-összeg)
  triggerPrice?: number; // stop/TP referencia-ár
  candle: Candle;
}

export interface SimFill {
  fillPrice: number;
  qty: number;
  amountUsd: number; // bruttó (qty * fillPrice)
  feeUsd: number;
}

/**
 * Egy order kitöltési árát számolja a gyertyából (a tüzelés tényét a hívó dönti el).
 *  - stop-loss SELL: min(trigger, open) − slippage  (gap-down a rosszabb open-on tölt)
 *  - take-profit SELL: max(trigger, open) − slippage (gap-up a jobb open-on tölt)
 *  - market BUY: close × (1 + slippage); market SELL: close × (1 − slippage)
 * Fee: BUY-nál az amountUsd-ből; SELL-nél a bruttóból. Tiszta — nincs IO/Date.now.
 */
export function simulateFill(req: FillRequest, feePct: number, slippageBps: number): SimFill | null {
  const slip = slippageBps / 10000;
  const c = req.candle;

  if (req.kind === "market" && req.side === "BUY") {
    const amountUsd = req.amountUsd ?? 0;
    if (amountUsd <= 0) return null;
    const fillPrice = c.close * (1 + slip);
    const feeUsd = amountUsd * feePct;
    const qty = (amountUsd - feeUsd) / fillPrice;
    if (qty <= 0) return null;
    return { fillPrice, qty, amountUsd, feeUsd };
  }

  // Minden más SELL (stop-loss / take-profit / market-SELL): qty alapú.
  const qty = req.qty ?? 0;
  if (qty <= 0) return null;
  let base: number;
  if (req.kind === "stop-loss") base = Math.min(req.triggerPrice!, c.open);
  else if (req.kind === "take-profit") base = Math.max(req.triggerPrice!, c.open);
  else base = c.close; // market SELL
  const fillPrice = base * (1 - slip);
  const gross = qty * fillPrice;
  const feeUsd = gross * feePct;
  return { fillPrice, qty, amountUsd: gross, feeUsd };
}

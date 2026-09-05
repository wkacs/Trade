/**
 * Paper (és backtest) teljesülés-modell (T05) — TISZTA függvény.
 *
 * Az audit §3 bizonyította: a régi kód automatikus stopnál a KORÁBBI stop-árat használta
 * papír teljesülési árnak, akkor is, ha az aktuális ár alacsonyabb volt. 95-ös stop és
 * 90-es megfigyelt ár mellett 95-ön „adott el". Ez túl kedvező modellezés.
 *
 * Az itteni szabály: a teljesülési ár a MEGFIGYELT árból indul, és a trigger sosem tehet
 * jobbá egy rosszabb megfigyelést.
 *
 *   market BUY   → ask (vagy last + fél spread), majd + slippage
 *   market SELL  → bid (vagy last − fél spread), majd − slippage
 *   stop-loss    → min(trigger, megfigyelt eladási ár), majd − slippage
 *   take-profit  → min(trigger, megfigyelt eladási ár), majd − slippage
 *
 * A take-profitnál is a MINIMUM a konzervatív: elavult adatnál nem könyvelünk el egy
 * soha meg nem történt, kedvezőbb árat.
 *
 * A díj a quote eszközben keletkezik, és a BUY-nál BELEFÉR a maxQuoteSpend keretbe:
 * a bruttó = maxQuoteSpend / (1 + feePct). Így a „legfeljebb ennyit költünk" ígéret
 * a díjjal EGYÜTT igaz.
 */
import { type Dec, ZERO, add, sub, mul, div, gt, isPositive, min as decMin } from "@/lib/portfolio/money";

export type PaperFillKind = "market" | "stop-loss" | "take-profit";

/** Megfigyelt piaci állapot. A bid/ask a pontosabb; last-ből a spread felével becslünk. */
export interface ObservedMarket {
  last?: Dec;
  bid?: Dec;
  ask?: Dec;
}

export interface PaperFillRequest {
  side: "BUY" | "SELL";
  kind: PaperFillKind;
  symbol: string;
  /** BUY: a teljes költési keret (díjjal együtt). */
  maxQuoteSpend?: Dec;
  /** SELL: az eladandó mennyiség. */
  baseQty?: Dec;
  /** stop-loss / take-profit referencia-ár. */
  triggerPrice?: Dec;
  market: ObservedMarket;
}

export interface PaperFillParams {
  /** Díj a bruttó hányadaként (0.001 = 0,1%). */
  feePct: Dec;
  /** Csúszás bázispontban (5 = 0,05%). */
  slippageBps: number;
  /** Teljes bid-ask spread bázispontban; bid/ask hiányában a last köré tesszük. */
  spreadBps: number;
  quoteAsset?: string;
}

export interface PaperFillOutcome {
  fillPrice: Dec;
  filledBaseQty: Dec;
  grossQuoteAmount: Dec;
  feeAmount: Dec;
  feeAsset: string;
  /** Az ár levezetése — a naplóban látszik, miből lett a fill. */
  basis: { referencePrice: Dec; source: "bid" | "ask" | "last" | "trigger"; slippageApplied: Dec };
}

export interface PaperFillRejection {
  ok: false;
  reason: "no_price" | "no_amount" | "zero_qty" | "zero_notional";
  message: string;
}

export type PaperFillResult = ({ ok: true } & PaperFillOutcome) | PaperFillRejection;

const bpsToFraction = (bps: number): Dec => div(String(bps), "10000");

/** A megfigyelt eladási/vételi referencia-ár. Bid/ask nélkül a last ± fél spread. */
export function referencePrice(
  side: "BUY" | "SELL",
  market: ObservedMarket,
  spreadBps: number,
): { price: Dec; source: "bid" | "ask" | "last" } | null {
  if (side === "BUY") {
    if (market.ask && isPositive(market.ask)) return { price: market.ask, source: "ask" };
  } else if (market.bid && isPositive(market.bid)) {
    return { price: market.bid, source: "bid" };
  }
  if (!market.last || !isPositive(market.last)) return null;
  const half = div(bpsToFraction(spreadBps), "2");
  const price = side === "BUY" ? mul(market.last, add("1", half)) : mul(market.last, sub("1", half));
  return { price, source: "last" };
}

/**
 * Egy paper teljesülés kiszámítása. Null helyett STRUKTURÁLT elutasítást ad, hogy a hívó
 * meg tudja különböztetni a „nincs ár" és a „nulla méret" esetet.
 */
export function simulatePaperFill(req: PaperFillRequest, params: PaperFillParams): PaperFillResult {
  const quoteAsset = params.quoteAsset ?? "USDT";
  const ref = referencePrice(req.side, req.market, params.spreadBps);
  if (!ref) {
    return { ok: false, reason: "no_price", message: `Nincs használható ár a ${req.symbol} teljesüléshez` };
  }

  const slip = bpsToFraction(params.slippageBps);
  let base = ref.price;
  let source: PaperFillOutcome["basis"]["source"] = ref.source;

  if (req.side === "SELL" && (req.kind === "stop-loss" || req.kind === "take-profit")) {
    if (!req.triggerPrice || !isPositive(req.triggerPrice)) {
      return { ok: false, reason: "no_price", message: `${req.kind}: hiányzó trigger-ár` };
    }
    // A trigger sosem tehet jobbá egy rosszabb megfigyelést (95-ös stop, 90-es ár → 90).
    const chosen = decMin(req.triggerPrice, ref.price);
    if (chosen === req.triggerPrice && chosen !== ref.price) source = "trigger";
    base = chosen;
  }

  const fillPrice = req.side === "BUY" ? mul(base, add("1", slip)) : mul(base, sub("1", slip));
  if (!isPositive(fillPrice)) {
    return { ok: false, reason: "no_price", message: "A csúszás után nem maradt pozitív ár" };
  }

  if (req.side === "BUY") {
    const budget = req.maxQuoteSpend;
    if (!budget || !isPositive(budget)) {
      return { ok: false, reason: "no_amount", message: "BUY: hiányzó vagy nulla maxQuoteSpend" };
    }
    // A díj BELEFÉR a keretbe: bruttó + bruttó*fee = budget.
    const gross = div(budget, add("1", params.feePct));
    const feeAmount = mul(gross, params.feePct);
    const qty = div(gross, fillPrice);
    if (!isPositive(qty)) {
      return { ok: false, reason: "zero_qty", message: "BUY: a keretből nem jön ki pozitív mennyiség" };
    }
    if (!gt(gross, ZERO)) {
      return { ok: false, reason: "zero_notional", message: "BUY: nulla bruttó érték" };
    }
    return {
      ok: true,
      fillPrice,
      filledBaseQty: qty,
      grossQuoteAmount: gross,
      feeAmount,
      feeAsset: quoteAsset,
      basis: { referencePrice: ref.price, source, slippageApplied: slip },
    };
  }

  const qty = req.baseQty;
  if (!qty || !isPositive(qty)) {
    return { ok: false, reason: "no_amount", message: "SELL: hiányzó vagy nulla baseQty" };
  }
  const gross = mul(qty, fillPrice);
  if (!isPositive(gross)) {
    return { ok: false, reason: "zero_notional", message: "SELL: nulla bruttó érték" };
  }
  return {
    ok: true,
    fillPrice,
    filledBaseQty: qty,
    grossQuoteAmount: gross,
    feeAmount: mul(gross, params.feePct),
    feeAsset: quoteAsset,
    basis: { referencePrice: ref.price, source, slippageApplied: slip },
  };
}

/** A paper végrehajtás alapértelmezett költségparaméterei (a backtest ugyanezt használja). */
export const DEFAULT_PAPER_FILL_PARAMS: PaperFillParams = {
  feePct: "0.001",
  slippageBps: 5,
  spreadBps: 2,
  quoteAsset: "USDT",
};

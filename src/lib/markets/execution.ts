/**
 * Asset-class-tudatos paper-végrehajtási paraméterek (Fázis 2).
 *
 * A `simulatePaperFill` (execution/paper-fill) MÁR quote-agnosztikus és decimális — a
 * `quoteAsset`, a fee/spread/slippage és a tőzsdei szűrők mind paraméterek. Ezért itt
 * NEM újraírjuk a fill-modellt; csak az instrumentum eszközosztályához illő
 * paramétereket és — Stooq híján — konzervatív részvény-szűrőket állítunk elő.
 *
 * Kripto: a meglévő default (USDT quote, 0,1% díj), a valós szűrőket az exchangeInfo adja.
 * Részvény: USD quote, ~0 jutalék (zero-commission bróker), tágabb spread (napi gyertya),
 * és beépített szűrők (0,01 tick, egész részvény lot, 1 USD min notional), mert a Stooq
 * nem ad exchangeInfo-t.
 */

import type { PaperFillParams } from "@/lib/execution/paper-fill";
import { DEFAULT_PAPER_FILL_PARAMS } from "@/lib/execution/paper-fill";
import type { SymbolFilters } from "@/lib/execution/exchange-rules";
import type { Instrument, AssetClass } from "./registry";

/**
 * Részvény-szűrők. Alapból KONZERVATÍV: egész darab, mert a gyertya-forrás (Yahoo) nem ad
 * tőzsdei szabályokat. Ha az Alpaca visszaigazolta, hogy MINDEN aktív papír `fractionable`,
 * a hívó `fractional: true`-val kéri — ekkor tört mennyiség is köthető, és a tétel-méret
 * nem kerekítődik nullára a drága papírokon (SPY ~770 USD).
 */
export function stockSymbolFilters(
  symbol: string,
  quote: string,
  nowMs: number,
  opts: { fractional?: boolean } = {},
): SymbolFilters {
  const fractional = opts.fractional === true;
  return {
    symbol,
    baseAsset: symbol,
    quoteAsset: quote,
    status: "TRADING",
    // Ár: centre kerekítés.
    tickSize: "0.01",
    minPrice: "0.01",
    maxPrice: null,
    // Mennyiség: egész részvény, vagy tört, ha az Alpaca szerint minden papír fractionable.
    stepSize: fractional ? "0.001" : "1",
    minQty: fractional ? "0.001" : "1",
    maxQty: null,
    marketStepSize: null,
    marketMinQty: null,
    marketMaxQty: null,
    // Min. kötésérték: 1 USD, market orderre is.
    minNotional: "1",
    applyMinToMarket: true,
    fetchedAt: nowMs,
  };
}

/** Az eszközosztály paper-fill költségparaméterei (szűrők nélkül). */
export function fillParamsForClass(assetClass: AssetClass): PaperFillParams {
  if (assetClass === "stock") {
    return {
      feePct: "0", // zero-commission bróker (paper)
      slippageBps: 5,
      spreadBps: 5, // tágabb, mert napi gyertyán fillelünk
      quoteAsset: "USD",
    };
  }
  // crypto — a meglévő default (USDT, 0,1% díj)
  return { ...DEFAULT_PAPER_FILL_PARAMS };
}

/**
 * Egy instrumentum teljes paper-fill paraméterkészlete.
 *
 * Kripto esetén a valós tőzsdei szűrőket a hívó adja (`filtersOverride`), mert azok az
 * exchangeInfo-ból jönnek. Részvénynél nincs override → a beépített konzervatív szűrők.
 */
export function fillParamsForInstrument(
  instrument: Instrument,
  nowMs: number,
  filtersOverride?: SymbolFilters,
): PaperFillParams {
  const base = fillParamsForClass(instrument.assetClass);
  base.quoteAsset = instrument.quote;

  if (filtersOverride) {
    base.filters = filtersOverride;
  } else if (instrument.assetClass === "stock") {
    base.filters = stockSymbolFilters(instrument.symbol, instrument.quote, nowMs);
  }
  base.nowMs = nowMs;
  return base;
}

/**
 * KÖZÖS kilépés-tervező (T21) — az órás és a gyors ág UGYANEZT hívja.
 *
 * Az audit B. szakasza szerint a gyors kilépésnek friss ÁRRA kell várnia, nem hírre,
 * sentimentre vagy LLM-re. Ez a modul ezért:
 *  - SOHA nem tervez BUY-t (a belépés az órás ág dolga);
 *  - csak friss quote-ból dolgozik, elavult árra NEM ad kilépést;
 *  - tiszta: nincs IO, nincs Date.now, nincs hálózat.
 *
 * A stop és a take-profit döntése ugyanaz a `evaluatePosition`, amit a backtest is
 * használ, így a két ág és a történelmi mérés nem csúszhat el egymástól.
 */
import { type Dec, ZERO, mul, div, gt, isPositive, toNumber, dec } from "@/lib/portfolio/money";
import { evaluatePosition } from "@/lib/strategy/position-actions";
import { ratchetStop } from "@/lib/strategy/trailing-stop";
import type { StrategyConfig } from "@/lib/strategy/config";
import type { Quote } from "@/lib/market/quotes";
import { quoteAgeMs } from "@/lib/market/quotes";

export interface ExitPosition {
  symbol: string;
  qty: Dec;
  /** Átlagos belépési ár (bekerülési érték / mennyiség). */
  entryPrice: Dec;
  stopPrice: Dec | null;
}

export interface PlannedExit {
  symbol: string;
  kind: "stop-loss" | "take-profit";
  /** Az eladandó mennyiség. */
  baseQty: Dec;
  /** A trigger referencia-ára (a fill ennél jobb nem lehet). */
  triggerPrice: Dec;
  /** Az az ár, amit ténylegesen LÁTTUNK (a bid). */
  observedPrice: Dec;
  reason: string;
}

export interface StopUpdate {
  symbol: string;
  newStop: Dec;
  previousStop: Dec | null;
}

export type ExitSkipReason = "missing_quote" | "stale_quote" | "zero_position" | "no_entry_price";

export interface ExitPlan {
  exits: PlannedExit[];
  stopUpdates: StopUpdate[];
  /** Miért maradt ki egy pozíció — mérhető állapot, nem néma kihagyás. */
  skipped: { symbol: string; reason: ExitSkipReason; ageMs?: number }[];
}

export interface ExitPlanInput {
  positions: ExitPosition[];
  /** Friss quote-ok symbolonként. Hiányzó vagy elavult → nincs kilépés arra a coinra. */
  quotes: Record<string, Quote>;
  nowMs: number;
  maxQuoteAgeMs: number;
  /**
   * Már beküldött, még nem teljesült kilépések symbolonként. Ezekre NEM tervezünk újat,
   * hogy ugyanaz a trigger két ciklusból ne könyvelődjön kétszer.
   */
  inFlightSymbols?: string[];
}

/**
 * Kilépés-terv friss quote-okból.
 *
 * A megfigyelt ár az ELADÁSI oldal (bid): ezen tudnánk most eladni. A trigger sosem tehet
 * jobbá egy rosszabb megfigyelést — ezt a fill-modell érvényesíti, itt a trigger csak
 * referencia.
 */
export function planExits(input: ExitPlanInput, config: StrategyConfig): ExitPlan {
  const exits: PlannedExit[] = [];
  const stopUpdates: StopUpdate[] = [];
  const skipped: ExitPlan["skipped"] = [];
  const inFlight = new Set(input.inFlightSymbols ?? []);

  for (const p of input.positions) {
    if (!isPositive(p.qty)) {
      skipped.push({ symbol: p.symbol, reason: "zero_position" });
      continue;
    }
    if (inFlight.has(p.symbol)) continue;

    const quote = input.quotes[p.symbol];
    if (!quote) {
      skipped.push({ symbol: p.symbol, reason: "missing_quote" });
      continue;
    }
    const age = quoteAgeMs(quote, input.nowMs);
    if (age > input.maxQuoteAgeMs) {
      // Elavult áron nem lépünk ki: az a fill hamis lenne.
      skipped.push({ symbol: p.symbol, reason: "stale_quote", ageMs: age });
      continue;
    }
    if (!isPositive(p.entryPrice)) {
      skipped.push({ symbol: p.symbol, reason: "no_entry_price" });
      continue;
    }

    const observed = toNumber(quote.bid);
    const action = evaluatePosition(
      {
        positionId: p.symbol,
        symbol: p.symbol,
        qty: toNumber(p.qty),
        entryPrice: toNumber(p.entryPrice),
        stopPrice: p.stopPrice ? toNumber(p.stopPrice) : 0,
        // Polling: csak a MEGFIGYELT árat látjuk, a gyertyán belüli szélsőértéket nem.
        low: observed,
        high: observed,
        close: observed,
      },
      { takeProfitPct: config.takeProfitPct, takeProfitFraction: config.takeProfitFraction },
    );

    if (action.kind !== "none") {
      const qty = mul(p.qty, dec(action.qtyFraction));
      if (isPositive(qty)) {
        exits.push({
          symbol: p.symbol,
          kind: action.kind,
          baseQty: qty,
          triggerPrice: dec(action.triggerPrice),
          observedPrice: quote.bid,
          reason: action.reason,
        });
      }
    }

    // Trailing ratchet: a stop CSAK felfelé kúszhat. Ugyanaz a mód, mint a belépéskor.
    const candidate = dec(observed * (1 - config.stopLossPct));
    const previous = p.stopPrice;
    const newStop = dec(ratchetStop(previous ? toNumber(previous) : 0, observed, config.stopLossPct));
    if (previous === null || gt(newStop, previous)) {
      stopUpdates.push({ symbol: p.symbol, newStop, previousStop: previous });
    }
    void candidate;
  }

  return { exits, stopUpdates, skipped };
}

/** Az ATR-alapú stop-távolság a gyors ágban (ha a config úgy kéri). */
export function stopCandidate(observedPrice: Dec, atr: Dec, config: StrategyConfig): Dec {
  if (config.stopMode === "atr" && isPositive(atr)) {
    const distance = mul(atr, dec(config.atrMult));
    const candidate = dec(toNumber(observedPrice) - toNumber(distance));
    return isPositive(candidate) ? candidate : ZERO;
  }
  return mul(observedPrice, dec(1 - config.stopLossPct));
}

/** Kényelmi segéd: a ledger pozícióiból kilépés-bemenet. */
export function exitPositionsFromLedger(
  positions: Record<string, { symbol: string; qty: Dec; costBasisQuote: Dec; stopPrice: Dec | null }>,
): ExitPosition[] {
  return Object.values(positions)
    .filter((p) => isPositive(p.qty))
    .map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      entryPrice: isPositive(p.qty) ? div(p.costBasisQuote, p.qty) : ZERO,
      stopPrice: p.stopPrice,
    }));
}

/**
 * Közös fill-könyvelő (T04) — a rendszer EGYETLEN könyvelési igazságforrása.
 *
 * Tiszta függvények: nincs DB, nincs hálózat, nincs Date.now. Ugyanezt a reducert
 * használja a paper végrehajtás, a backtest és a DB-perzisztencia (a `toSqlDeltas`
 * kimenete megy az `apply_fill_v2` SQL-függvénynek). Így nincs két, egymástól elcsúszó
 * elszámolás — az audit §3 pontosan ezt a driftet mutatta ki (a demó a bruttót írta a
 * cash-hez, a backtest a nettót).
 *
 * DÍJKEZELÉS (audit §3): a díj a SAJÁT eszközében jelenik meg, pontosan egyszer.
 *   - quote-díj  → a készpénzt csökkenti (BUY-nál a bekerülési értéket is növeli)
 *   - base-díj   → a jóváírt mennyiséget csökkenti (a bekerülési érték nem változik)
 *   - harmadik eszköz (pl. BNB) → annak az eszköznek az egyenlegét csökkenti; USD-re
 *     NEM számítjuk át, így nem vonódik le másodszor
 */
import {
  type Dec,
  ZERO,
  add,
  sub,
  mul,
  div,
  gt,
  gte,
  lt,
  lte,
  isPositive,
  neg,
  dec,
} from "@/lib/portfolio/money";
import { fillKey, type Fill, type TradingMode } from "@/lib/execution/contracts";

/** Egy nyitott (vagy épp lezáruló) pozíció a v2 ledgerben. */
export interface LedgerPosition {
  symbol: string;
  qty: Dec;
  /** A birtokolt mennyiség TELJES bekerülési értéke quote-ban, a vételi díjjal együtt. */
  costBasisQuote: Dec;
  stopPrice: Dec | null;
}

export interface LedgerState {
  portfolioId: string;
  mode: TradingMode;
  /** Eszközönkénti egyenleg. A quote (USDT) mellett a díj-eszközök is itt élnek. */
  cash: Record<string, Dec>;
  positions: Record<string, LedgerPosition>;
  /** A már elkönyvelt fill-kulcsok — a memóriabeli dedup tükrözi a DB egyediségét. */
  appliedFillKeys: string[];
  /** Halmozott realizált eredmény quote-ban (díjak után). */
  realizedPnlQuote: Dec;
}

export interface LedgerOptions {
  /** A quote eszköz neve. Alapértelmezés USDT (a kosár minden párja USDT-s). */
  quoteAsset?: string;
  /**
   * Dust-küszöb: ha az eladás után ennyinél kevesebb marad, a pozíció LEZÁRTNAK számít,
   * és a maradék bekerülési érték is beleszámít a realizált eredménybe. 0 = nincs dust-zárás.
   */
  dustBaseQty?: Dec;
  /** BUY után beállítandó stop-ár. Ha nincs megadva, a meglévő stop marad. */
  stopPrice?: Dec | null;
}

export type LedgerErrorCode =
  | "duplicate_fill"
  | "scope_mismatch"
  | "insufficient_cash"
  | "insufficient_position";

export interface LedgerError {
  code: LedgerErrorCode;
  message: string;
}

/** A DB-nek átadandó, explicit deltak (az apply_fill_v2 bemenete). */
export interface SqlDeltas {
  cash: { asset: string; delta: Dec }[];
  position: { symbol: string; qtyDelta: Dec; costDelta: Dec; stopPrice: Dec | null } | null;
  reservation: { intentId: string; consumeQuote: Dec } | null;
  fence?: { leaseKey: string; owner: string; fencingToken: number };
}

export interface ApplyFillResult {
  state: LedgerState;
  applied: boolean;
  error?: LedgerError;
  /** A könyvelt deltak (a DB ugyanezt kapja). Nem alkalmazott fillnél null. */
  deltas: SqlDeltas | null;
  /** Ennek a fillnek a realizált eredménye quote-ban (SELL-nél értelmes). */
  realizedPnlQuote: Dec;
}

const DEFAULT_QUOTE = "USDT";

export function emptyLedger(
  portfolioId: string,
  mode: TradingMode,
  openingCash: Dec = ZERO,
  quoteAsset = DEFAULT_QUOTE,
): LedgerState {
  return {
    portfolioId,
    mode,
    cash: { [quoteAsset]: dec(openingCash) },
    positions: {},
    appliedFillKeys: [],
    realizedPnlQuote: ZERO,
  };
}

export function cashOf(state: LedgerState, asset: string): Dec {
  return state.cash[asset] ?? ZERO;
}

export function positionQty(state: LedgerState, symbol: string): Dec {
  return state.positions[symbol]?.qty ?? ZERO;
}

/** Az adott áraknál számolt teljes equity quote-ban (készpénz + készlet piaci értéke). */
export function equityAt(state: LedgerState, prices: Record<string, Dec>, quoteAsset = DEFAULT_QUOTE): Dec {
  let total = cashOf(state, quoteAsset);
  for (const p of Object.values(state.positions)) {
    const px = prices[p.symbol];
    if (px === undefined) continue;
    total = add(total, mul(p.qty, px));
  }
  return total;
}

/** Nem realizált eredmény a megadott árakon. Hiányzó ár esetén az adott pozíció kimarad. */
export function unrealizedPnl(state: LedgerState, prices: Record<string, Dec>): Dec {
  let total = ZERO;
  for (const p of Object.values(state.positions)) {
    const px = prices[p.symbol];
    if (px === undefined || !isPositive(p.qty)) continue;
    total = add(total, sub(mul(p.qty, px), p.costBasisQuote));
  }
  return total;
}

const clone = (s: LedgerState): LedgerState => ({
  portfolioId: s.portfolioId,
  mode: s.mode,
  cash: { ...s.cash },
  positions: Object.fromEntries(Object.entries(s.positions).map(([k, v]) => [k, { ...v }])),
  appliedFillKeys: [...s.appliedFillKeys],
  realizedPnlQuote: s.realizedPnlQuote,
});

const fail = (state: LedgerState, code: LedgerErrorCode, message: string): ApplyFillResult => ({
  state,
  applied: false,
  error: { code, message },
  deltas: null,
  realizedPnlQuote: ZERO,
});

/**
 * Egy teljesülés elkönyvelése. Idempotens: ugyanaz a fill-kulcs másodszor nem mozgat
 * egyenleget (applied=false, duplicate_fill). Nem enged tiltottan negatív készpénzt vagy
 * készletet — ilyenkor a művelet ELUTASÍTÁSRA kerül, nem „majdnem sikerül".
 */
export function applyFill(state: LedgerState, fill: Fill, options: LedgerOptions = {}): ApplyFillResult {
  const quoteAsset = options.quoteAsset ?? DEFAULT_QUOTE;
  const dust = options.dustBaseQty ?? ZERO;
  const key = fill.fillId || fillKey(fill.mode, fill.exchangeOrderId, fill.exchangeTradeId);

  if (fill.portfolioId !== state.portfolioId || fill.mode !== state.mode) {
    return fail(
      state,
      "scope_mismatch",
      `A fill hatóköre (${fill.portfolioId}/${fill.mode}) nem egyezik a ledgerével (${state.portfolioId}/${state.mode})`,
    );
  }
  if (state.appliedFillKeys.includes(key)) {
    return { state, applied: false, error: { code: "duplicate_fill", message: `Már könyvelt fill: ${key}` }, deltas: null, realizedPnlQuote: ZERO };
  }

  const next = clone(state);
  const cashDeltas: Record<string, Dec> = {};
  const bump = (asset: string, delta: Dec) => {
    cashDeltas[asset] = add(cashDeltas[asset] ?? ZERO, delta);
  };

  const feeInQuote = fill.feeAsset === quoteAsset;
  const feeInBase = fill.feeAsset === fill.symbol;
  const feeInThird = !feeInQuote && !feeInBase;

  let qtyDelta: Dec;
  let costDelta: Dec;
  let realized: Dec = ZERO;

  if (fill.side === "BUY") {
    // A jóváírt mennyiség: base-díj esetén a coinból vonja le a tőzsde.
    qtyDelta = feeInBase ? sub(fill.filledBaseQty, fill.feeAmount) : fill.filledBaseQty;
    if (!isPositive(qtyDelta)) {
      return fail(next, "insufficient_position", `A base-díj felemészti a teljes mennyiséget (${fill.fillId})`);
    }
    // A bekerülési érték a bruttó + a quote-ban fizetett díj. Harmadik eszközű díjat NEM
    // számítunk USD-re: az a saját egyenlegében jelenik meg.
    costDelta = feeInQuote ? add(fill.grossQuoteAmount, fill.feeAmount) : fill.grossQuoteAmount;

    bump(quoteAsset, neg(fill.grossQuoteAmount));
    if (feeInQuote) bump(quoteAsset, neg(fill.feeAmount));
    if (feeInThird) bump(fill.feeAsset, neg(fill.feeAmount));
  } else {
    const pos = next.positions[fill.symbol];
    const held = pos?.qty ?? ZERO;
    // Base-díj SELL-nél is előfordulhat: ekkor a levont mennyiség is a készletből megy.
    const totalBaseOut = feeInBase ? add(fill.filledBaseQty, fill.feeAmount) : fill.filledBaseQty;
    if (!pos || lt(held, totalBaseOut)) {
      return fail(
        next,
        "insufficient_position",
        `Nem birtokolt vagy túlméretes eladás: ${fill.symbol} ${totalBaseOut} > ${held}`,
      );
    }
    // Arányos bekerülési érték a részleges záráshoz.
    const proportionalCost = gt(held, ZERO) ? mul(pos.costBasisQuote, div(fill.filledBaseQty, held)) : ZERO;
    qtyDelta = neg(totalBaseOut);
    costDelta = neg(proportionalCost);

    bump(quoteAsset, fill.grossQuoteAmount);
    if (feeInQuote) bump(quoteAsset, neg(fill.feeAmount));
    if (feeInThird) bump(fill.feeAsset, neg(fill.feeAmount));

    const netProceeds = feeInQuote ? sub(fill.grossQuoteAmount, fill.feeAmount) : fill.grossQuoteAmount;
    realized = sub(netProceeds, proportionalCost);

    // Dust-zárás: a maradék bekerülési érték is realizálódik, hogy ne ragadjon bent.
    const remaining = add(held, qtyDelta);
    if (gt(dust, ZERO) && lte(remaining, dust) && gt(remaining, ZERO)) {
      const leftoverCost = sub(pos.costBasisQuote, proportionalCost);
      realized = sub(realized, leftoverCost);
      qtyDelta = neg(held);
      costDelta = neg(pos.costBasisQuote);
    }
  }

  // Fedezet-ellenőrzés MINDEN érintett eszközre — nincs tiltottan negatív egyenleg.
  for (const [asset, delta] of Object.entries(cashDeltas)) {
    const after = add(cashOf(next, asset), delta);
    if (lt(after, ZERO)) {
      return fail(
        next,
        "insufficient_cash",
        `Fedezethiány ${asset}: ${cashOf(next, asset)} + ${delta} < 0`,
      );
    }
  }

  for (const [asset, delta] of Object.entries(cashDeltas)) {
    next.cash[asset] = add(cashOf(next, asset), delta);
  }

  const existing = next.positions[fill.symbol];
  const newQty = add(existing?.qty ?? ZERO, qtyDelta);
  const newCost = add(existing?.costBasisQuote ?? ZERO, costDelta);
  if (lt(newQty, ZERO)) {
    return fail(next, "insufficient_position", `A készlet negatívba menne: ${fill.symbol} ${newQty}`);
  }
  if (isPositive(newQty)) {
    // A RÁVÁSÁRLÁS SOSEM VISZI LEJJEBB a már felhúzott (trailing) stopot — az audit §4
    // szerint a régi kód minden BUY-nál újraszámolta a stopot entry*(1−5%)-ra, így egy
    // emelkedésben felkúszott védelem egyetlen kis vétellel visszaesett.
    const requestedStop = fill.side === "BUY" ? options.stopPrice : undefined;
    const keptStop = existing?.stopPrice ?? null;
    const stopPrice =
      requestedStop === undefined
        ? keptStop
        : requestedStop === null
          ? keptStop
          : keptStop === null
            ? requestedStop
            : gt(requestedStop, keptStop)
              ? requestedStop
              : keptStop;
    next.positions[fill.symbol] = {
      symbol: fill.symbol,
      qty: newQty,
      costBasisQuote: lt(newCost, ZERO) ? ZERO : newCost,
      stopPrice,
    };
  } else {
    delete next.positions[fill.symbol];
  }

  next.realizedPnlQuote = add(next.realizedPnlQuote, realized);
  next.appliedFillKeys = [...next.appliedFillKeys, key];

  const deltas: SqlDeltas = {
    cash: Object.entries(cashDeltas).map(([asset, delta]) => ({ asset, delta })),
    position: {
      symbol: fill.symbol,
      qtyDelta,
      costDelta,
      stopPrice: fill.side === "BUY" && options.stopPrice !== undefined ? options.stopPrice : null,
    },
    reservation: null,
  };

  return { state: next, applied: true, deltas, realizedPnlQuote: realized };
}

/** Több fill sorrendben. Az első hiba MEGÁLLÍTJA a sort — nem könyvelünk félig. */
export function applyFills(
  state: LedgerState,
  fills: Fill[],
  options: LedgerOptions = {},
): { state: LedgerState; results: ApplyFillResult[]; error?: LedgerError } {
  let current = state;
  const results: ApplyFillResult[] = [];
  for (const f of fills) {
    const r = applyFill(current, f, options);
    results.push(r);
    if (r.error && r.error.code !== "duplicate_fill") {
      return { state: current, results, error: r.error };
    }
    current = r.state;
  }
  return { state: current, results };
}

/** A foglalás elszámolása hozzáadva a deltakhoz (a beküldött BUY kerete a fillel fogy). */
export function withReservation(deltas: SqlDeltas, intentId: string, consumeQuote: Dec): SqlDeltas {
  return { ...deltas, reservation: { intentId, consumeQuote } };
}

/** A pozíció stop-ára a ledgerben (a trailing ratchet írja). */
export function setStop(state: LedgerState, symbol: string, stopPrice: Dec): LedgerState {
  const pos = state.positions[symbol];
  if (!pos) return state;
  const next = clone(state);
  next.positions[symbol] = { ...pos, stopPrice };
  return next;
}

/** Igaz, ha a megadott mennyiség ténylegesen eladható (birtokolt készletből). */
export function canSell(state: LedgerState, symbol: string, baseQty: Dec): boolean {
  return gte(positionQty(state, symbol), baseQty) && isPositive(baseQty);
}

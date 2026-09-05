/**
 * Védőorder teljes életciklusa (T26).
 *
 * A régi kód a BUY után best-effort STOP_LOSS_LIMIT ordert küldött, és hiba esetén csak
 * `console.error`-t írt — majd a ciklus zavartalanul ment tovább, akár újabb vétellel.
 * A pozíció közben VÉDELEM NÉLKÜL maradt. A DB-ben tárolt trailing stop frissítése pedig
 * önmagában NEM módosítja a tőzsdén ülő ordert.
 *
 * Amit ez a modul kimond:
 *  - a védett mennyiség a NETTÓ birtokolt mennyiség: rávásárlás és részleges eladás után
 *    is egyeznie kell;
 *  - a trailing ratchet a tőzsdei ordert is CSERÉLI (cancel + place), nem csak a DB-t;
 *  - a védelem hiánya INCIDENS: amíg fennáll, ÚJ VÉTEL TILOS;
 *  - a cancel és a place KÖZÖTT bekövetkező fill külön eset, amit jelölni kell;
 *  - a kényszerpiaci zárás NEM rejtett alapértelmezés — ilyet ez a modul nem tervez.
 *
 * Tiszta függvények: nincs IO, nincs Date.now.
 */
import { type Dec, ZERO, sub, abs, gt, lt, gte, isPositive, dec } from "@/lib/portfolio/money";
import type { OrderState } from "./contracts";
import { protectionPrices, roundQty, type SymbolFilters } from "./exchange-rules";
import type { StrategyConfig } from "@/lib/strategy/config";

/** Egy tőzsdén ÜLŐ védőorder. */
export interface ProtectionOrder {
  symbol: string;
  exchangeOrderId: string;
  clientOrderId: string;
  /** A védett mennyiség. */
  qty: Dec;
  stopPrice: Dec;
  limitPrice: Dec;
  state: OrderState;
  placedAt: number;
}

export interface ProtectionPosition {
  symbol: string;
  /** A NETTÓ birtokolt mennyiség (a ledgerből). */
  qty: Dec;
  /** A kívánt stop-ár (a trailing ratchet eredménye). */
  desiredStop: Dec | null;
}

export type ProtectionActionKind = "place" | "cancel" | "replace";

export interface ProtectionAction {
  kind: ProtectionActionKind;
  symbol: string;
  /** cancel/replace esetén a MEGLÉVŐ order azonosítója. */
  cancelOrderId?: string;
  /** place/replace esetén az ÚJ védőorder paraméterei. */
  qty?: Dec;
  stopPrice?: Dec;
  limitPrice?: Dec;
  reason: string;
}

export type ProtectionIncidentCode =
  | "unprotected_position"
  | "qty_mismatch"
  | "stale_stop"
  | "place_failed"
  | "cancel_failed"
  | "fill_during_replace"
  | "orphan_protection"
  | "missing_filters";

export interface ProtectionIncident {
  code: ProtectionIncidentCode;
  symbol: string;
  message: string;
  /** Igaz, ha emiatt ÚJ VÉTEL TILOS, amíg fenn nem oldódik. */
  blocksNewBuys: boolean;
}

export interface ProtectionPlan {
  actions: ProtectionAction[];
  incidents: ProtectionIncident[];
}

export interface ProtectionInput {
  positions: ProtectionPosition[];
  /** A tőzsdén ülő védőorderek symbolonként. */
  existing: Record<string, ProtectionOrder | undefined>;
  filters: Record<string, SymbolFilters | undefined>;
  /** A mennyiség-eltérés tűréshatára (kerekítési zaj). */
  qtyTolerance?: Dec;
}

/**
 * Védőorder-terv. Sorrend: a CANCEL mindig megelőzi a hozzá tartozó PLACE-t, mert a
 * pihenő order zárolja a készletet — enélkül az új order fedezethiányra futna.
 */
export function planProtection(input: ProtectionInput, config: StrategyConfig): ProtectionPlan {
  const actions: ProtectionAction[] = [];
  const incidents: ProtectionIncident[] = [];
  const tolerance = input.qtyTolerance ?? "0";
  const seen = new Set<string>();

  for (const p of input.positions) {
    seen.add(p.symbol);
    const existing = input.existing[p.symbol];
    const filters = input.filters[p.symbol];

    if (!isPositive(p.qty)) {
      // Nincs mit védeni. A bent maradt védőorder árva → törölni kell.
      if (existing) {
        actions.push({
          kind: "cancel",
          symbol: p.symbol,
          cancelOrderId: existing.exchangeOrderId,
          reason: "A pozíció lezárult, a védőorder árva maradt.",
        });
        incidents.push({
          code: "orphan_protection",
          symbol: p.symbol,
          message: `A ${p.symbol} pozíció nulla, de van élő védőorder (${existing.exchangeOrderId}).`,
          blocksNewBuys: false,
        });
      }
      continue;
    }

    if (!filters) {
      incidents.push({
        code: "missing_filters",
        symbol: p.symbol,
        message: `Nincs szűrőkészlet a ${p.symbol}-hoz — védőorder nem tervezhető.`,
        blocksNewBuys: true,
      });
      continue;
    }
    if (!p.desiredStop || !isPositive(p.desiredStop)) {
      incidents.push({
        code: "unprotected_position",
        symbol: p.symbol,
        message: `A ${p.symbol} pozícióhoz nincs stop-ár — VÉDELEM NÉLKÜL van.`,
        blocksNewBuys: true,
      });
      continue;
    }

    const { stop, limit } = protectionPrices(p.desiredStop, filters);
    const qty = roundQty(p.qty, filters, "LIMIT");

    if (!existing) {
      actions.push({
        kind: "place",
        symbol: p.symbol,
        qty,
        stopPrice: stop,
        limitPrice: limit,
        reason: "Nincs élő védőorder a nyitott pozícióra.",
      });
      incidents.push({
        code: "unprotected_position",
        symbol: p.symbol,
        message: `A ${p.symbol} pozíció jelenleg VÉDELEM NÉLKÜL van — védőorder feladása szükséges.`,
        blocksNewBuys: true,
      });
      continue;
    }

    const qtyDiff = abs(sub(existing.qty, qty));
    const qtyChanged = gt(qtyDiff, tolerance);
    const stopChanged = existing.stopPrice !== stop;

    if (qtyChanged) {
      incidents.push({
        code: "qty_mismatch",
        symbol: p.symbol,
        message: `A védett mennyiség (${existing.qty}) eltér a birtokolttól (${qty}).`,
        // A RÉSZBEN védett pozíció is védtelen a különbözetre.
        blocksNewBuys: lt(existing.qty, qty),
      });
    }
    if (stopChanged && !qtyChanged) {
      incidents.push({
        code: "stale_stop",
        symbol: p.symbol,
        message: `A tőzsdei stop (${existing.stopPrice}) eltér a kívánttól (${stop}) — a DB-frissítés önmagában nem elég.`,
        blocksNewBuys: false,
      });
    }

    if (qtyChanged || stopChanged) {
      actions.push({
        kind: "replace",
        symbol: p.symbol,
        cancelOrderId: existing.exchangeOrderId,
        qty,
        stopPrice: stop,
        limitPrice: limit,
        reason: qtyChanged
          ? "A birtokolt mennyiség megváltozott (rávásárlás vagy részleges eladás)."
          : "A trailing stop feljebb lépett — a TŐZSDEI ordert is cserélni kell.",
      });
    }
  }

  // Olyan védőorder, amihez már nincs pozíció a listában.
  for (const [symbol, order] of Object.entries(input.existing)) {
    if (!order || seen.has(symbol)) continue;
    actions.push({
      kind: "cancel",
      symbol,
      cancelOrderId: order.exchangeOrderId,
      reason: "Nincs hozzá tartozó pozíció.",
    });
    incidents.push({
      code: "orphan_protection",
      symbol,
      message: `Árva védőorder: ${symbol} (${order.exchangeOrderId}).`,
      blocksNewBuys: false,
    });
  }

  void config;
  return { actions, incidents };
}

/**
 * Szabad-e ÚJ vételt indítani? A védelem hiánya vagy hiányos volta TILT — nem
 * folytatjuk a normál működést egy elbukott stop-feladás után.
 */
export function protectionGate(incidents: ProtectionIncident[]): { allowNewBuys: boolean; blocking: ProtectionIncident[] } {
  const blocking = incidents.filter((i) => i.blocksNewBuys);
  return { allowNewBuys: blocking.length === 0, blocking };
}

export interface ExecutionOutcome {
  action: ProtectionAction;
  ok: boolean;
  /** A cancel és a place KÖZÖTT teljesült-e a pozíció? */
  filledDuringReplace?: boolean;
  error?: string;
  newOrderId?: string;
}

/**
 * A végrehajtás eredményéből INCIDENSEK. Egy elbukott feladás nem log-sor, hanem
 * blokkoló incidens; a csere közbeni fill külön eset, mert ott a készlet elfogyott.
 */
export function incidentsFromOutcomes(outcomes: ExecutionOutcome[]): ProtectionIncident[] {
  const out: ProtectionIncident[] = [];
  for (const o of outcomes) {
    if (o.filledDuringReplace) {
      out.push({
        code: "fill_during_replace",
        symbol: o.action.symbol,
        message: `A ${o.action.symbol} pozíció a védőorder cseréje KÖZBEN teljesült — a készlet elfogyott, új védőorder nem kell.`,
        blocksNewBuys: false,
      });
      continue;
    }
    if (o.ok) continue;
    if (o.action.kind === "cancel") {
      out.push({
        code: "cancel_failed",
        symbol: o.action.symbol,
        message: `A védőorder törlése nem sikerült (${o.action.cancelOrderId}): ${o.error ?? "ismeretlen hiba"}`,
        blocksNewBuys: true,
      });
    } else {
      out.push({
        code: "place_failed",
        symbol: o.action.symbol,
        message: `A védőorder feladása nem sikerült: ${o.error ?? "ismeretlen hiba"} — a pozíció VÉDELEM NÉLKÜL van.`,
        blocksNewBuys: true,
      });
    }
  }
  return out;
}

/**
 * Helyreállítási terv induláskor: mit kell tenni, hogy MINDEN nyitott pozíció védve
 * legyen. Ugyanaz a tervező, csak explicit néven — a runbook erre hivatkozik.
 */
export function planRecovery(input: ProtectionInput, config: StrategyConfig): ProtectionPlan {
  return planProtection(input, config);
}

/** A védett és a birtokolt mennyiség eltérése symbolonként (riporthoz). */
export function protectionGaps(
  positions: ProtectionPosition[],
  existing: Record<string, ProtectionOrder | undefined>,
): { symbol: string; held: Dec; protectedQty: Dec; gap: Dec }[] {
  return positions
    .filter((p) => isPositive(p.qty))
    .map((p) => {
      const protectedQty = existing[p.symbol]?.qty ?? ZERO;
      return { symbol: p.symbol, held: p.qty, protectedQty, gap: sub(p.qty, protectedQty) };
    })
    .filter((r) => !gte(r.protectedQty, r.held) || isPositive(dec(r.gap)));
}

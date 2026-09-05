/**
 * Előremenő paper összevetés — árnyékszámlák (T31).
 *
 * MIÉRT KELL: a backteszt nem tud AI-döntést mérni (a múlt nem rekonstruálható), és a
 * fill-modellje közelítés. Az egyetlen becsületes mód: a javított alapvonal és a jelölt
 * EGYSZERRE fut, UGYANAZOKON a bemeneteken, KÜLÖN papírszámlán, előre.
 *
 * AMIT EZ A MODUL GARANTÁL:
 *  - Minden árnyékszámla SAJÁT `portfolioId`-t kap, és minden számla `paper`. Live
 *    számlát a készlet SOHA nem tartalmazhat — ezt a `validateShadowSet` kényszeríti.
 *  - Nincs átjárás: egy intent csak a SAJÁT számlájára könyvelhető, és egy számla
 *    kerete sem használható másikra. A `crossAccountGuard` ezt ellenőrzi.
 *  - Az azonos induló tőke és az azonos bemenet a mérés feltétele: eltérő tőkével a
 *    hozamok nem hasonlíthatók össze (a minimum kötésérték máshogy szorít).
 *  - A megfigyelés addig NYITOTT, amíg a cél (30 nap, 50 lezárt körforduló) nincs meg.
 *    Néhány nap után „nyert" verdikt nem adható.
 *
 * Tiszta függvények: nincs IO, nincs Date.now.
 */
import type { StrategyConfig } from "@/lib/strategy/config";
import type { ExecutionIntent, TradingMode } from "@/lib/execution/contracts";
import type { LedgerState } from "@/lib/portfolio/ledger";
import type { RunSummary, Uncertainty } from "./experiment";

export interface ShadowAccount {
  /** Rövid azonosító, pl. "baseline" vagy "atr2". */
  id: string;
  label: string;
  /** A számla saját portfólió-azonosítója. KÜLÖN minden számlánál. */
  portfolioId: string;
  mode: TradingMode;
  startingCapitalUsd: number;
  strategy: StrategyConfig;
  /**
   * Fut-e ezen a számlán az AI-döntés. Az AI-hívás KÖZÖS: egyszer fut le, és minden
   * AI-os számla ugyanazt a döntést kapja — így a bemenet azonos, és a költség nem
   * szorzódik a számlák számával.
   */
  aiEnabled: boolean;
  /** Igaz a referenciaszámlára (pontosan egy lehet). */
  isBaseline: boolean;
}

export interface ShadowSetOptions {
  /** Az azonosítók elé kerülő névtér, hogy az éles paper számlától elkülönüljön. */
  namespace?: string;
  startingCapitalUsd: number;
}

export interface ShadowIssue {
  accountId?: string;
  message: string;
}

const DEFAULT_NAMESPACE = "shadow";

/** Egy árnyékszámla portfólió-azonosítója. Determinisztikus, hogy újraindítható legyen. */
export function shadowPortfolioId(id: string, namespace = DEFAULT_NAMESPACE): string {
  return `${namespace}:${id}`;
}

export interface ShadowDefinition {
  id: string;
  label: string;
  strategy: StrategyConfig;
  aiEnabled?: boolean;
}

/**
 * Az árnyékkészlet felépítése. Az ELSŐ definíció a referenciaszámla (a javított
 * alapvonal); a többi jelölt. Minden számla azonos induló tőkét kap.
 */
export function defineShadowSet(
  baseline: ShadowDefinition,
  candidates: ShadowDefinition[],
  options: ShadowSetOptions,
): ShadowAccount[] {
  const ns = options.namespace ?? DEFAULT_NAMESPACE;
  const mk = (d: ShadowDefinition, isBaseline: boolean): ShadowAccount => ({
    id: d.id,
    label: d.label,
    portfolioId: shadowPortfolioId(d.id, ns),
    mode: "paper",
    startingCapitalUsd: options.startingCapitalUsd,
    strategy: d.strategy,
    aiEnabled: d.aiEnabled ?? false,
    isBaseline,
  });
  return [mk(baseline, true), ...candidates.map((c) => mk(c, false))];
}

/**
 * A készlet érvényessége. Ez a mérés előfeltétele: hibás készlettel a számok
 * összehasonlíthatatlanok, és a legrosszabb esetben átfolyik pénz a számlák között.
 */
export function validateShadowSet(accounts: ShadowAccount[]): ShadowIssue[] {
  const issues: ShadowIssue[] = [];
  if (accounts.length < 2) issues.push({ message: "Legalább két számla kell (alapvonal + jelölt)." });

  const baselines = accounts.filter((a) => a.isBaseline);
  if (baselines.length !== 1) {
    issues.push({ message: `Pontosan egy alapvonal kell, most ${baselines.length} van.` });
  }

  const ids = new Set<string>();
  const portfolios = new Set<string>();
  for (const a of accounts) {
    if (a.mode !== "paper") {
      issues.push({ accountId: a.id, message: "ÉLES számla nem lehet árnyékszámla — a készlet csak paper lehet." });
    }
    if (ids.has(a.id)) issues.push({ accountId: a.id, message: "Ismétlődő számla-azonosító." });
    ids.add(a.id);
    if (portfolios.has(a.portfolioId)) {
      issues.push({ accountId: a.id, message: `Két számla ugyanazt a portfolioId-t használja: ${a.portfolioId}.` });
    }
    portfolios.add(a.portfolioId);
    if (a.startingCapitalUsd !== accounts[0].startingCapitalUsd) {
      issues.push({
        accountId: a.id,
        message: `Eltérő induló tőke (${a.startingCapitalUsd} vs ${accounts[0].startingCapitalUsd}) — a hozamok nem hasonlíthatók össze.`,
      });
    }
    if (a.startingCapitalUsd <= 0) {
      issues.push({ accountId: a.id, message: "Az induló tőke nem lehet nulla vagy negatív." });
    }
  }
  return issues;
}

/**
 * Egy intent a SAJÁT számlájára szól-e. Hamis visszatérésnél az intent nem hajtható
 * végre: a cross-account könyvelés a mérést és a pénzt is elrontaná.
 */
export function crossAccountGuard(
  intent: Pick<ExecutionIntent, "portfolioId" | "mode">,
  account: ShadowAccount,
): { ok: boolean; reason: string | null } {
  if (intent.mode !== "paper") {
    return { ok: false, reason: `Az árnyékszámlán csak paper intent futhat, ez ${intent.mode}.` };
  }
  if (intent.portfolioId !== account.portfolioId) {
    return {
      ok: false,
      reason: `Az intent a ${intent.portfolioId} számlára szól, a végrehajtó számla ${account.portfolioId}.`,
    };
  }
  return { ok: true, reason: null };
}

/** A ledger tényleg ehhez a számlához tartozik-e (izoláció-ellenőrzés betöltés után). */
export function ledgerBelongsTo(ledger: Pick<LedgerState, "portfolioId" | "mode">, account: ShadowAccount): boolean {
  return ledger.portfolioId === account.portfolioId && ledger.mode === account.mode;
}

// ────────────────────────────────────────────────────────────────────────────────
// Előrehaladás és verdikt
// ────────────────────────────────────────────────────────────────────────────────

export interface ShadowTarget {
  /** Megfigyelési cél napokban. */
  minDays: number;
  /** Lezárt körfordulók célszáma (a REFERENCIA számlán). */
  minRoundTrips: number;
}

/** A T31 elfogadási céljai. Ezek a mérés ELŐTT rögzítettek. */
export const SHADOW_TARGET: ShadowTarget = { minDays: 30, minRoundTrips: 50 };

export interface ShadowProgress {
  observedDays: number;
  roundTrips: number;
  daysMet: boolean;
  roundTripsMet: boolean;
  /** Igaz, ha MINDKÉT cél teljesült. Addig a mérés NYITOTT. */
  complete: boolean;
  message: string;
}

export function shadowProgress(
  startedAtMs: number,
  nowMs: number,
  roundTrips: number,
  target: ShadowTarget = SHADOW_TARGET,
): ShadowProgress {
  const observedDays = Math.max(0, (nowMs - startedAtMs) / 86_400_000);
  const daysMet = observedDays >= target.minDays;
  const roundTripsMet = roundTrips >= target.minRoundTrips;
  const complete = daysMet && roundTripsMet;
  const message = complete
    ? `A megfigyelési cél teljesült: ${observedDays.toFixed(1)} nap, ${roundTrips} lezárt körforduló. ` +
      "A korrelált kötések miatt ez akkor sem statisztikai garancia, csak elegendő minta a beszélgetéshez."
    : `A megfigyelés NYITOTT: ${observedDays.toFixed(1)}/${target.minDays} nap, ` +
      `${roundTrips}/${target.minRoundTrips} lezárt körforduló. Verdikt még nem adható.`;
  return { observedDays, roundTrips, daysMet, roundTripsMet, complete, message };
}

// ────────────────────────────────────────────────────────────────────────────────
// Incidensek
// ────────────────────────────────────────────────────────────────────────────────

export type ShadowIncidentKind =
  | "missing_tick"
  | "stale_quote"
  | "persist_failed"
  | "unknown_order"
  | "cross_account_blocked"
  | "data_gap";

export interface ShadowIncident {
  ts: number;
  accountId: string | null;
  kind: ShadowIncidentKind;
  detail: string;
}

/**
 * Az incidensek összegzése. A jelentésben szerepelnie KELL: egy „jobb" eredmény, ami
 * mellett a másik számla fele tickje kimaradt, nem eredmény.
 */
export function summarizeIncidents(incidents: ShadowIncident[]): { total: number; byKind: Record<string, number>; note: string } {
  const byKind: Record<string, number> = {};
  for (const i of incidents) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  const note =
    incidents.length === 0
      ? "Nem volt rögzített incidens."
      : `${incidents.length} incidens — az eredmény ezek ismeretében értelmezendő (a kimaradt ciklus torzít).`;
  return { total: incidents.length, byKind, note };
}

// ────────────────────────────────────────────────────────────────────────────────
// Összevetés
// ────────────────────────────────────────────────────────────────────────────────

export interface ShadowAccountStats {
  account: ShadowAccount;
  summary: RunSummary;
  uncertainty: Uncertainty | null;
  /** Hány ciklus futott le ezen a számlán (a kimaradás torzít). */
  cycles: number;
  incidents: number;
}

export interface ShadowComparison {
  baselineId: string;
  candidateId: string;
  /** A díjak UTÁNI hozamkülönbség. */
  deltaNetReturnPct: number;
  deltaMaxDrawdownPct: number;
  deltaCostUsd: number;
  /** Igaz, ha a két számla nem ugyanannyi ciklust látott — ilyenkor az eltérés nem tiszta. */
  cycleMismatch: boolean;
  verdict: "open" | "candidate_better" | "baseline_better" | "no_difference";
  statement: string;
}

/**
 * Két árnyékszámla összevetése.
 *
 * A verdikt CSAK akkor lehet valami más, mint „open", ha a megfigyelési cél teljesült,
 * a ciklusszám egyezik, és a kötésenkénti intervallumok nem fednek át. Minden más
 * esetben a mérés nyitva marad — ez nem döntetlen, hanem hiányzó bizonyíték.
 */
export function compareShadowAccounts(
  baseline: ShadowAccountStats,
  candidate: ShadowAccountStats,
  progress: ShadowProgress,
): ShadowComparison {
  const delta = candidate.summary.netReturnPct - baseline.summary.netReturnPct;
  const cycleMismatch = baseline.cycles !== candidate.cycles;
  const base = {
    baselineId: baseline.account.id,
    candidateId: candidate.account.id,
    deltaNetReturnPct: delta,
    deltaMaxDrawdownPct: candidate.summary.maxDrawdownPct - baseline.summary.maxDrawdownPct,
    deltaCostUsd: candidate.summary.totalFeesUsd - baseline.summary.totalFeesUsd,
    cycleMismatch,
  };

  if (!progress.complete) {
    return { ...base, verdict: "open", statement: progress.message };
  }
  if (cycleMismatch) {
    return {
      ...base,
      verdict: "open",
      statement:
        `A két számla nem ugyanannyi ciklust látott (${baseline.cycles} vs ${candidate.cycles}), ` +
        "ezért az eltérés nem a stratégiának tulajdonítható.",
    };
  }
  const bu = baseline.uncertainty;
  const cu = candidate.uncertainty;
  if (!bu || !cu) {
    return { ...base, verdict: "open", statement: "Túl kevés kötés a bizonytalanság becsléséhez." };
  }
  const overlap = bu.ci95[0] <= cu.ci95[1] && cu.ci95[0] <= bu.ci95[1];
  if (overlap) {
    return {
      ...base,
      verdict: "no_difference",
      statement:
        `A költségek utáni eltérés ${(delta * 100).toFixed(2)} százalékpont, de a kötésenkénti ` +
        "intervallumok átfednek: a különbség a mintából nem kimutatható.",
    };
  }
  return {
    ...base,
    verdict: delta > 0 ? "candidate_better" : "baseline_better",
    statement:
      `A költségek utáni eltérés ${(delta * 100).toFixed(2)} százalékpont, és a kötésenkénti ` +
      `intervallumok nem fednek át. Lehúzás-különbség: ${(base.deltaMaxDrawdownPct * 100).toFixed(2)} ` +
      "százalékpont. Ez akkor sem garancia a jövőre nézve, csak a megfigyelt időszak leírása.",
  };
}

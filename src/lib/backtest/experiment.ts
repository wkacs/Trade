/**
 * Összehasonlító mérések — a kísérleti protokoll végrehajtó rétege (T30).
 *
 * Tiszta függvények: nincs IO, nincs Date.now, nincs hálózat. A történetet és a
 * futtatót a hívó adja (`scripts/compare-strategies.ts`), így ugyanaz a bemenet
 * ugyanazt a jelentést adja — ez a reprodukálhatóság feltétele.
 *
 * MIT VÉD EZ A MODUL:
 *  - „A jelölt jobb lett" állítás nem születhet meg a MINTA nagysága nélkül. Ha kevés a
 *    lezárt kötés vagy hiányzik az adat, az eredmény NEM ELDÖNTHETŐ, nem siker.
 *  - A kilépési ütem összehasonlítása csak akkor érvényes, ha a BELÉPÉSEK azonosak.
 *    Ezt a modul ellenőrzi, nem feltételezi.
 *  - A gyenge variánsok bent maradnak a jelentésben. Nincs „a legjobbat mutatjuk" szűrés,
 *    és nincs automatikus stratégiaváltás: a modul csak MÉR, nem kapcsol.
 */
import type { BacktestResult, EntryEvent, HistoryFrame, RealizationEvent } from "./types";

// ────────────────────────────────────────────────────────────────────────────────
// Egy futás összefoglalása
// ────────────────────────────────────────────────────────────────────────────────

export interface RunSummary {
  initialCapitalUsd: number;
  finalEquityUsd: number;
  /** Nettó hozam a díjak UTÁN (a backteszt equity-je már nettó). */
  netReturnPct: number;
  maxDrawdownPct: number;
  exposurePct: number;
  /** Teljesen lezárt pozíciók száma — a mintanagyság alapja. */
  closedTrades: number;
  /** Minden realizálás, a részlegesek is. */
  realizationCount: number;
  totalFeesUsd: number;
  /** A díj a ZÁRÓ tőke arányában (a költségkerethez). */
  costPct: number;
  /** Megforgatott érték quote-ban (vétel + eladás). */
  turnoverUsd: number;
  /** Forgalom / induló tőke — hányszor forgattuk meg a tőkét. */
  turnoverRatio: number;
  /** Miért nem lett order (a kockázati kapu elutasításai). */
  rejections: Record<string, number>;
}

export function summarize(result: BacktestResult): RunSummary {
  const initial = result.config.initialCapitalUsd;
  const last = result.equityCurve[result.equityCurve.length - 1]?.equityUsd ?? initial;
  const buyVolume = result.entries.reduce((s, e) => s + e.amountUsd, 0);
  const sellVolume = result.realizations.reduce((s, r) => s + r.qty * r.exitPrice, 0);
  const turnover = buyVolume + sellVolume;
  return {
    initialCapitalUsd: initial,
    finalEquityUsd: last,
    netReturnPct: initial > 0 ? (last - initial) / initial : 0,
    maxDrawdownPct: result.metrics.maxDrawdownPct,
    exposurePct: result.metrics.exposurePct,
    closedTrades: result.closedTrades.length,
    realizationCount: result.realizations.length,
    totalFeesUsd: result.metrics.totalFeesUsd,
    costPct: last > 0 ? result.metrics.totalFeesUsd / last : Number.POSITIVE_INFINITY,
    turnoverUsd: turnover,
    turnoverRatio: initial > 0 ? turnover / initial : 0,
    rejections: result.rejections,
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// Bizonytalanság
// ────────────────────────────────────────────────────────────────────────────────

export interface Uncertainty {
  /** Hány realizálásból számoltunk. */
  n: number;
  meanPct: number;
  stdDevPct: number;
  /** A középérték szórása — ez mondja meg, mennyire hihető az átlag. */
  standardErrorPct: number;
  /** 95%-os konfidencia-intervallum a KÖTÉSENKÉNTI átlagra. */
  ci95: [number, number];
}

/**
 * A kötésenkénti eredmény bizonytalansága.
 *
 * SZÁNDÉKOSAN egyszerű (normál közelítés): a kötések korreláltak — három együtt mozgó
 * eszköz —, ezért egy bonyolultabb becslés is hamis pontosságot sugallna. Az
 * intervallum arra jó, hogy egy „+2%-kal jobb" állítás mellé odakerüljön, mekkora
 * szórásból származik.
 *
 * Két realizálás alatt `null`: egyetlen kötésből nincs bizonytalanság-becslés.
 */
export function tradeUncertainty(realizations: RealizationEvent[]): Uncertainty | null {
  const rets = realizations.filter((r) => r.costBasisUsd > 0).map((r) => r.pnlUsd / r.costBasisUsd);
  const n = rets.length;
  if (n < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  return { n, meanPct: mean, stdDevPct: sd, standardErrorPct: se, ci95: [mean - 1.96 * se, mean + 1.96 * se] };
}

// ────────────────────────────────────────────────────────────────────────────────
// Adat- és mintaelégségesség
// ────────────────────────────────────────────────────────────────────────────────

export type Decidability = "decidable" | "insufficient_sample" | "insufficient_data";

export interface Sufficiency {
  status: Decidability;
  reason: string | null;
}

/**
 * Eldönthető-e egyáltalán az eredmény.
 *
 * A hiányzó adat és a kevés kötés KÜLÖN eset: az első mérési hiba, a második a piac
 * tulajdonsága. Egyik sem „a stratégia nem működik".
 */
export function sufficiency(
  summary: RunSummary,
  options: { minClosedTrades: number; bars: number; minBars: number },
): Sufficiency {
  if (options.bars < options.minBars) {
    return {
      status: "insufficient_data",
      reason: `${options.bars} gyertya áll rendelkezésre, a méréshez ${options.minBars} kell.`,
    };
  }
  if (summary.closedTrades < options.minClosedTrades) {
    return {
      status: "insufficient_sample",
      reason: `${summary.closedTrades} lezárt kötés, a küszöb ${options.minClosedTrades} — az eredmény nem eldönthető.`,
    };
  }
  return { status: "decidable", reason: null };
}

// ────────────────────────────────────────────────────────────────────────────────
// Összehasonlítás
// ────────────────────────────────────────────────────────────────────────────────

export interface Comparison {
  deltaReturnPct: number;
  deltaDrawdownPct: number;
  deltaCostPct: number;
  deltaTurnoverRatio: number;
  /**
   * Igaz, ha a két kötésenkénti konfidencia-intervallum ÁTFED — ilyenkor a különbség
   * a mintából nem különböztethető meg a zajtól, akkor sem, ha a hozam eltér.
   */
  intervalsOverlap: boolean | null;
  /** Emberi nyelvű összegzés, hamis pontosság nélkül. */
  statement: string;
}

export function compareRuns(
  baseline: { summary: RunSummary; uncertainty: Uncertainty | null },
  candidate: { summary: RunSummary; uncertainty: Uncertainty | null },
): Comparison {
  const dRet = candidate.summary.netReturnPct - baseline.summary.netReturnPct;
  const overlap =
    baseline.uncertainty && candidate.uncertainty
      ? baseline.uncertainty.ci95[0] <= candidate.uncertainty.ci95[1] &&
        candidate.uncertainty.ci95[0] <= baseline.uncertainty.ci95[1]
      : null;

  let statement: string;
  if (overlap === null) {
    statement = "Túl kevés kötés a bizonytalanság becsléséhez — az eltérés nem értelmezhető.";
  } else if (overlap) {
    statement =
      `A hozam eltérése ${(dRet * 100).toFixed(2)} százalékpont, de a kötésenkénti ` +
      "konfidencia-intervallumok ÁTFEDNEK: a különbség a zajtól nem különböztethető meg.";
  } else {
    statement =
      `A hozam eltérése ${(dRet * 100).toFixed(2)} százalékpont, és a kötésenkénti ` +
      "intervallumok NEM fednek át.";
  }

  return {
    deltaReturnPct: dRet,
    deltaDrawdownPct: candidate.summary.maxDrawdownPct - baseline.summary.maxDrawdownPct,
    deltaCostPct: candidate.summary.costPct - baseline.summary.costPct,
    deltaTurnoverRatio: candidate.summary.turnoverRatio - baseline.summary.turnoverRatio,
    intervalsOverlap: overlap,
    statement,
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// A kilépési ütem IZOLÁLT vizsgálata
// ────────────────────────────────────────────────────────────────────────────────

export interface EntryDiff {
  identical: boolean;
  /** Az első eltérés leírása — enélkül az összehasonlítás érvénytelen. */
  firstDifference: string | null;
  countA: number;
  countB: number;
}

/**
 * Azonosak-e a belépések két futásban. A kilépési ütem hatását CSAK így lehet mérni:
 * ha a belépések is eltérnek, nem tudjuk, melyik okozta a különbséget.
 */
export function compareEntries(a: EntryEvent[], b: EntryEvent[]): EntryDiff {
  if (a.length !== b.length) {
    return {
      identical: false,
      firstDifference: `Eltérő belépés-szám: ${a.length} vs ${b.length}.`,
      countA: a.length,
      countB: b.length,
    };
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.ts !== y.ts || x.symbol !== y.symbol || x.qty !== y.qty || x.fillPrice !== y.fillPrice) {
      return {
        identical: false,
        firstDifference:
          `A ${i + 1}. belépés eltér: ${x.symbol} ${x.qty} @ ${x.fillPrice} (${x.ts}) ` +
          `vs ${y.symbol} ${y.qty} @ ${y.fillPrice} (${y.ts}).`,
        countA: a.length,
        countB: b.length,
      };
    }
  }
  return { identical: true, firstDifference: null, countA: a.length, countB: b.length };
}

export interface CadenceOutcome {
  cadenceMin: number;
  status: "measured" | "insufficient_resolution";
  reason: string | null;
  summary: RunSummary | null;
  entryDiff: EntryDiff | null;
}

/**
 * A kilépési ütem vizsgálata. A mérés felbontása a történet gyertyaköze: **órás adaton
 * a 60 percnél sűrűbb kilépés nem mérhető**, mert nincs, amiből kiszámolni. Ezt a modul
 * kimondja, nem közelíti — egy „5 perces kilépés órás adaton" szám kitalált lenne.
 */
export function exitCadenceStudy(
  cadencesMin: readonly number[],
  frameSpacingMin: number,
  run: (cadenceMin: number) => BacktestResult | null,
): CadenceOutcome[] {
  let reference: EntryEvent[] | null = null;
  return cadencesMin.map((cadenceMin) => {
    if (cadenceMin < frameSpacingMin) {
      return {
        cadenceMin,
        status: "insufficient_resolution",
        reason:
          `A történet ${frameSpacingMin} perces felbontású, ezért a ${cadenceMin} perces ` +
          "kilépés nem mérhető rajta. Ehhez finomabb gyertya kell.",
        summary: null,
        entryDiff: null,
      };
    }
    const result = run(cadenceMin);
    if (!result) {
      return { cadenceMin, status: "insufficient_resolution", reason: "A futás nem adott eredményt.", summary: null, entryDiff: null };
    }
    const entryDiff = reference ? compareEntries(reference, result.entries) : null;
    reference ??= result.entries;
    return { cadenceMin, status: "measured", reason: null, summary: summarize(result), entryDiff };
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// Jelentés
// ────────────────────────────────────────────────────────────────────────────────

export interface VariantRow {
  experimentId: string;
  variantId: string;
  label: string;
  raisesRisk: boolean;
  scenario: { costId: string; capitalId: string; executionModel: string };
  summary: RunSummary;
  uncertainty: Uncertainty | null;
  sufficiency: Sufficiency;
  /** Az alapvonalhoz mért eltérés — a baseline sorban `null`. */
  comparison: Comparison | null;
}

export interface ExperimentReport {
  protocolVersion: string;
  protocolHash: string;
  strategyVersion: string;
  developmentDataHash: string;
  holdoutDataHash: string;
  bars: { development: number; holdout: number };
  rows: VariantRow[];
  controls: VariantRow[];
  cadences: CadenceOutcome[];
  /** Amit a mérés NEM tudott eldönteni — kimondva, nem elhallgatva. */
  openQuestions: string[];
  generatedFrom: { frames: number; from: number; to: number };
}

/**
 * A jelentés determinisztikus ujjlenyomata. KÉT AZONOS BEMENETŰ FUTÁSNAK azonos hash-t
 * kell adnia; ha nem, a mérés nem reprodukálható, és az eredménye nem használható.
 *
 * A `generatedFrom` és minden szám benne van, de időbélyeg NINCS: a futtatás ideje nem
 * a mérés része.
 */
export function reportHash(report: ExperimentReport): string {
  const payload = JSON.stringify({
    protocolHash: report.protocolHash,
    developmentDataHash: report.developmentDataHash,
    holdoutDataHash: report.holdoutDataHash,
    rows: report.rows.map(rowKey),
    controls: report.controls.map(rowKey),
    cadences: report.cadences.map((c) => [c.cadenceMin, c.status, c.summary?.netReturnPct ?? null]),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function rowKey(r: VariantRow) {
  return [
    r.experimentId,
    r.variantId,
    r.scenario.costId,
    r.scenario.capitalId,
    r.scenario.executionModel,
    r.summary.netReturnPct,
    r.summary.maxDrawdownPct,
    r.summary.totalFeesUsd,
    r.summary.turnoverUsd,
    r.summary.closedTrades,
    r.sufficiency.status,
  ];
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

/** Egy sor emberi olvasásra. A nem eldönthető eredmény NEM kap hozam-értelmezést. */
export function formatRow(r: VariantRow): string {
  const s = r.summary;
  const base =
    `| ${r.variantId} | ${r.scenario.capitalId}/${r.scenario.costId} | ${pct(s.netReturnPct)} | ` +
    `${pct(s.maxDrawdownPct)} | ${pct(s.exposurePct)} | ${s.turnoverRatio.toFixed(2)}× | ` +
    `${s.totalFeesUsd.toFixed(2)} USD (${pct(s.costPct)}) | ${s.closedTrades} |`;
  if (r.sufficiency.status !== "decidable") return `${base} ⚠ ${r.sufficiency.reason} |`;
  const u = r.uncertainty;
  const ci = u ? `átlag ${pct(u.meanPct)} ± ${pct(1.96 * u.standardErrorPct)}` : "nincs becslés";
  return `${base} ${ci} |`;
}

/** A teljes jelentés markdownban — ez kerül a `docs/experiments/results-v1.md`-be. */
export function formatReport(report: ExperimentReport): string {
  const head = [
    `Protokoll: ${report.protocolVersion} (hash ${report.protocolHash})`,
    `Stratégia: ${report.strategyVersion}`,
    `Adat: fejlesztés ${report.bars.development} gyertya (hash ${report.developmentDataHash}), ` +
      `holdout ${report.bars.holdout} gyertya (hash ${report.holdoutDataHash})`,
    `Jelentés-hash: ${reportHash(report)}`,
  ].join("\n");

  const header =
    "| variáns | tőke/költség | nettó | max DD | kitettség | forgalom | költség | kötés | bizonytalanság |\n" +
    "|---|---|---|---|---|---|---|---|---|";

  const sections = [
    head,
    "",
    "## Kontrollok",
    header,
    ...report.controls.map(formatRow),
    "",
    "## Variánsok",
    header,
    ...report.rows.map(formatRow),
  ];

  if (report.cadences.length > 0) {
    sections.push("", "## Kilépési ütem (izolált)");
    for (const c of report.cadences) {
      if (c.status !== "measured") {
        sections.push(`- ${c.cadenceMin} perc: NEM MÉRHETŐ — ${c.reason}`);
      } else {
        const diff = c.entryDiff && !c.entryDiff.identical ? ` ⚠ a belépések ELTÉRNEK: ${c.entryDiff.firstDifference}` : "";
        sections.push(`- ${c.cadenceMin} perc: nettó ${pct(c.summary!.netReturnPct)}, max DD ${pct(c.summary!.maxDrawdownPct)}${diff}`);
      }
    }
  }

  if (report.openQuestions.length > 0) {
    sections.push("", "## Nyitva maradt kérdések");
    for (const q of report.openQuestions) sections.push(`- ${q}`);
  }

  return sections.join("\n");
}

/** A történet gyertyaköze percben (a felbontás-ellenőrzéshez). */
export function frameSpacingMinutes(frames: HistoryFrame[]): number {
  if (frames.length < 2) return 60;
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  return Math.max(1, Math.round((sorted[1].ts - sorted[0].ts) / 60_000));
}

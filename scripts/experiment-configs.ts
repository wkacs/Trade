/**
 * Előre rögzített profitkísérleti protokoll — GÉPI FORMA (T29).
 *
 * A prózai leírás: `docs/experiments/protocol-v1.md`. Ez a fájl ugyanannak a
 * protokollnak a végrehajtható változata, hogy a mérés ne emlékezetből, hanem
 * kódból induljon újra.
 *
 * MIÉRT ÍGY:
 *  - Az audit §8 szerint a korábbi „tournament" a TESZT-ablakon választott jelöltet,
 *    és a küszöböt utólag igazította a látott eredményhez. Ezért itt MINDEN elfogadási
 *    küszöb, kockázati keret és költségfeltevés a jelöltválasztás ELŐTT fagy be, és a
 *    `protocolHash()` láthatóvá teszi, ha valaki utólag hozzányúlt.
 *  - Egy kísérlet EGY kérdést vizsgál: a változatok kizárólag a megnevezett tengely
 *    paramétereiben térhetnek el. Ezt a `validateExperiment()` ellenőrzi, nem a jóhiszem.
 *  - Kockázatemelés nem csúszhat be „mellékesen": ha egy változat lazább limitet
 *    használ, azt `raisesRisk: true`-val KELL jelölni, és ilyen változat felhasználói
 *    kockázatdöntés nélkül nem adoptálható.
 *
 * Ez a fájl NEM futtat mérést. A mérés a `scripts/compare-strategies.ts` (T30).
 */
import { DEFAULT_STRATEGY, STRATEGY_VERSION, type StrategyConfig } from "@/lib/strategy/config";

/** A protokoll verziója. Változtatás = ÚJ protokoll, nem „javított" régi. */
export const PROTOCOL_VERSION = "exp-v1-2026-09-05";

// ────────────────────────────────────────────────────────────────────────────────
// 1) Kockázati és költségkeret — a jelöltválasztás ELŐTT rögzítve
// ────────────────────────────────────────────────────────────────────────────────

export interface FrozenBudget {
  /** Ennél nagyobb lehúzás mellett a jelölt ELUTASÍTOTT, bármilyen hozam mellett. */
  maxDrawdownPct: number;
  /** A díj + slippage összege a záró tőke arányában. Efölött a jelölt elutasított. */
  maxCostBudgetPct: number;
  /** Piacban töltött idő felső korlátja (kitettség). */
  maxExposurePct: number;
  /** Ennyi lezárt kötés alatt az eredmény NEM ELDÖNTHETŐ (nem siker és nem bukás). */
  minClosedTrades: number;
  /** A holdouton ennyivel kell felülmúlnia a vak alapvonalat, hogy elfogadható legyen. */
  minEdgeOverBaselinePct: number;
}

/**
 * A KERET. 2026-09-05-én rögzítve, a mérések előtt.
 *
 * A −25% drawdown a jelenlegi 100 USD-s papírtőkére szánt felső tűréshatár; nem
 * célérték. A 3%-os költségkeret a mai díj (0.1%) mellett kb. 30 körfordulónak felel
 * meg a teljes tőkén: efölött a stratégia a brókert gazdagítja.
 */
export const FROZEN_BUDGET: FrozenBudget = {
  maxDrawdownPct: 0.25,
  maxCostBudgetPct: 0.03,
  maxExposurePct: 0.9,
  minClosedTrades: 30,
  minEdgeOverBaselinePct: 0.02,
};

// ────────────────────────────────────────────────────────────────────────────────
// 2) Adatablak és felosztás — előre fagyasztva
// ────────────────────────────────────────────────────────────────────────────────

export interface FrozenWindow {
  symbols: string[];
  /** Órás gyertyák. */
  intervalHours: number;
  /** Kért történeti hossz napokban. A ténylegesen elérhetőt a dataHash rögzíti. */
  requestedDays: number;
  /** A holdout a legfrissebb rész, ekkora aránnyal. EGYSZER mérünk rajta. */
  holdoutRatio: number;
  /** Gördülő tanuló/validáló felosztás a FEJLESZTÉSI részen. */
  rolling: { trainBars: number; validationBars: number; stepBars: number };
  /** Szeletenként ennyi kötés alatt a jelölt nem rangsorolható. */
  minTradesPerSplit: number;
}

export const FROZEN_WINDOW: FrozenWindow = {
  symbols: ["BTC", "ETH", "SOL"],
  intervalHours: 1,
  requestedDays: 365,
  holdoutRatio: 0.2,
  rolling: { trainBars: 24 * 60, validationBars: 24 * 20, stepBars: 24 * 20 },
  minTradesPerSplit: 3,
};

// ────────────────────────────────────────────────────────────────────────────────
// 3) Költség- és tőkeforgatókönyvek
// ────────────────────────────────────────────────────────────────────────────────

export interface CostScenario {
  id: string;
  label: string;
  feePct: number;
  slippageBps: number;
  /** Tőzsdei minimum kötésérték quote-ban. */
  minOrderQuote: number;
}

/**
 * ALAP és EMELT költség. Az emelt nem pesszimizmus-gyakorlat: kis tőkén a spread és a
 * részleges teljesülés rendszeresen többe kerül a névleges díjnál.
 */
export const COST_SCENARIOS: CostScenario[] = [
  { id: "base", label: "alap (0.10% díj, 5 bps slippage)", feePct: 0.001, slippageBps: 5, minOrderQuote: 5 },
  { id: "elevated", label: "emelt (0.15% díj, 25 bps slippage)", feePct: 0.0015, slippageBps: 25, minOrderQuote: 5 },
];

export interface CapitalScenario {
  id: string;
  initialCapitalUsd: number;
  note: string;
}

/**
 * A 100 USD a valós helyzet, a 10 000 USD a kontroll: a minimum notional és a díj
 * fixköltség-jellege kis tőkén máshogy hat, mint nagyon. Ha egy stratégia csak
 * 10 000-en működik, azt ki kell mondani.
 */
export const CAPITAL_SCENARIOS: CapitalScenario[] = [
  { id: "small", initialCapitalUsd: 100, note: "a tényleges papírtőke" },
  { id: "large", initialCapitalUsd: 10_000, note: "kontroll: a minimum notional itt nem szorít" },
];

/** A kilépés-ciklus vizsgált sűrűségei percben (T21 izolált vizsgálat). */
export const EXIT_CADENCES_MIN = [1, 5, 15, 60] as const;

// ────────────────────────────────────────────────────────────────────────────────
// 4) Kísérletek — egy kísérlet EGY kérdés
// ────────────────────────────────────────────────────────────────────────────────

/** A `StrategyConfig` kulcsai, amelyeken egy kísérlet tengelye futhat. */
export type StrategyAxis = keyof StrategyConfig;

export interface Variant {
  id: string;
  label: string;
  strategy: StrategyConfig;
  /**
   * Igaz, ha a változat LAZÍT egy kockázati limiten a jelenlegi éleshez képest.
   * Ilyen változat felhasználói kockázatdöntés nélkül NEM adoptálható.
   */
  raisesRisk: boolean;
  note: string;
}

export interface Experiment {
  id: string;
  /** A megválaszolandó kérdés — egy mondat, mérhető formában. */
  question: string;
  /** A vizsgált tengely: a változatok KIZÁRÓLAG ezekben a kulcsokban térhetnek el. */
  axis: StrategyAxis[];
  variants: Variant[];
}

/** Egy változat a `DEFAULT_STRATEGY`-ből, felsorolt eltérésekkel. */
function variant(id: string, label: string, patch: Partial<StrategyConfig>, note: string): Variant {
  const strategy: StrategyConfig = { ...DEFAULT_STRATEGY, ...patch };
  return { id, label, strategy, raisesRisk: isRiskier(strategy, DEFAULT_STRATEGY), note };
}

/**
 * Kockázat-lazítás felismerése. Csak a TÉNYLEGESEN kockázatnövelő irányt nézi:
 * nagyobb pozíció, több egyidejű pozíció, távolabbi stop, nagyobb DCA-keret,
 * magasabb napi veszteségtűrés.
 */
export function isRiskier(candidate: StrategyConfig, baseline: StrategyConfig): boolean {
  return (
    candidate.maxPositionPct > baseline.maxPositionPct ||
    candidate.maxConcurrentPositions > baseline.maxConcurrentPositions ||
    candidate.stopLossPct > baseline.stopLossPct ||
    candidate.dcaWeeklyBudgetPct > baseline.dcaWeeklyBudgetPct ||
    candidate.dcaBuyPct > baseline.dcaBuyPct ||
    candidate.dailyLossCircuitBreakerPct > baseline.dailyLossCircuitBreakerPct ||
    candidate.riskPerTradePct > baseline.riskPerTradePct
  );
}

/** Két stratégia eltérő kulcsai. */
export function strategyDiff(a: StrategyConfig, b: StrategyConfig): StrategyAxis[] {
  return (Object.keys(a) as StrategyAxis[]).filter((k) => a[k] !== b[k]);
}

/**
 * A KÍSÉRLETEK. Mindegyik a javított DCA-alapvonalhoz méri magát; a `baseline`
 * változat mindenhol maga a `DEFAULT_STRATEGY`, hogy az összehasonlítás azonos
 * motorral és azonos adaton történjen.
 */
export const EXPERIMENTS: Experiment[] = [
  {
    id: "E1-dca-threshold",
    question: "A félelem-kapu szigorítása vagy lazítása javít-e a DCA nettó eredményén?",
    axis: ["dcaFgThreshold"],
    variants: [
      variant("baseline", "alapvonal (FG ≤ 20)", {}, "a jelenlegi éles beállítás"),
      variant("fg15", "FG ≤ 15", { dcaFgThreshold: 15 }, "ritkább, mélyebb félelem"),
      variant("fg25", "FG ≤ 25", { dcaFgThreshold: 25 }, "gyakoribb belépés"),
      variant("fg30", "FG ≤ 30", { dcaFgThreshold: 30 }, "a legmegengedőbb kapu"),
    ],
  },
  {
    id: "E2-momentum",
    question: "Hozzáad-e a momentum-belépő a DCA-alapvonalhoz, azonos kockázati kereten belül?",
    axis: ["momentumEnabled"],
    variants: [
      variant("baseline", "momentum KI", {}, "a jelenlegi éles beállítás"),
      variant("momentum-on", "momentum BE", { momentumEnabled: true }, "azonos méret, csak a belépő kapcsol"),
    ],
  },
  {
    id: "E3-take-profit",
    question: "A teljes vagy a részleges profitrealizálás ad jobb kockázat-hozam arányt?",
    axis: ["takeProfitPct", "takeProfitFraction"],
    variants: [
      variant("baseline", "+10% / teljes", {}, "a jelenlegi éles beállítás"),
      variant("tp15-half", "+15% / fél", { takeProfitPct: 0.15, takeProfitFraction: 0.5 }, "korábbi beállítás"),
      variant("tp7-full", "+7% / teljes", { takeProfitPct: 0.07 }, "gyorsabb realizálás"),
    ],
  },
  {
    id: "E4-entry-filter",
    question: "A trend-szűrő javít-e, vagy csak kihagyott belépéseket okoz?",
    axis: ["entryFilter"],
    variants: [
      variant("baseline", "trend-szűrő BE", {}, "a jelenlegi éles beállítás"),
      variant("filter-off", "trend-szűrő KI", { entryFilter: "off" }, "minden jelzés belép"),
    ],
  },
  {
    id: "E6-risk-ladder-L2",
    question:
      "A kockázat-létra L2 lépcsője (lazább félelem-kapu + nagyobb pozíció + futni hagyott nyertes) " +
      "jobb nettó eredményt ad-e ELŐRE MENŐ paper-mérésben, mint a jelenlegi élő beállítás?",
    // TÖBB tengely EGYSZERRE: ez szándékos, mert a felhasználó a CSOMAGOT akarja mérni.
    // Ára: ha nyer, nem tudjuk megmondani, MELYIK elem nyert. Ezt a riportban ki kell mondani.
    axis: [
      "dcaFgThreshold",
      "dcaBuyPct",
      "dcaWeeklyBudgetPct",
      "maxPositionPct",
      "takeProfitPct",
      "takeProfitFraction",
    ],
    variants: [
      variant("baseline", "a jelenlegi éles beállítás", {}, "viszonyítási pont"),
      variant(
        "L2",
        "L2: FG35 · DCA 4%/heti 20% · max pozíció 35% · TP 25% teljes",
        {
          dcaFgThreshold: 35,
          dcaBuyPct: 0.04,
          dcaWeeklyBudgetPct: 0.2,
          maxPositionPct: 0.35,
          takeProfitPct: 0.25,
          takeProfitFraction: 1,
        },
        "KOCKÁZATEMELÉS, a felhasználó kifejezett döntése alapján (2026-09-06). " +
          "A történeti mérésen ez volt az egyetlen lépcső, amely MINDKÉT rezsimben javított " +
          "az alapvonalhoz képest: medvében -9.0% (alapvonal -0.1%), bikában +17.0% (alapvonal +4.7%), " +
          "a teljes cikluson kamatosan +6.5% (alapvonal +4.6%).",
      ),
    ],
  },
  {
    id: "E5-stop-mode",
    question: "Az ATR-alapú stop jobb-e a fix −5%-nál, kockázatnövelés nélkül?",
    axis: ["stopMode", "atrMult"],
    variants: [
      variant("baseline", "fix −5%", {}, "a jelenlegi éles beállítás"),
      variant("atr2", "ATR × 2", { stopMode: "atr", atrMult: 2 }, "volatilitáshoz igazodó stop"),
      variant("atr3", "ATR × 3", { stopMode: "atr", atrMult: 3 }, "lazább ATR-stop"),
    ],
  },
];

/**
 * A protokollon KÍVÜLI, de előre rögzített kontrollok. Ezek nem jelöltek: viszonyítási
 * pontok, amelyek nélkül egy pozitív hozam nem jelent semmit.
 */
export const CONTROLS = [
  { id: "cash", label: "készpénz (nem csinálunk semmit)" },
  { id: "buy-and-hold", label: "egyenlő súlyú buy & hold" },
  { id: "ai-free", label: "AI nélküli kontroll: ugyanaz a kód, LLM-döntés nélkül" },
] as const;

// ────────────────────────────────────────────────────────────────────────────────
// 5) Elfogadási szabály — a mérés ELŐTT rögzítve
// ────────────────────────────────────────────────────────────────────────────────

export interface AcceptanceInput {
  /** A jelölt holdout-eredménye. */
  netReturnPct: number;
  maxDrawdownPct: number;
  exposurePct: number;
  closedTrades: number;
  totalFeesUsd: number;
  finalEquityUsd: number;
  /** A vak alapvonal (buy & hold) hozama UGYANAZON az ablakon. */
  baselineReturnPct: number;
}

export type AcceptanceVerdict = "accept" | "reject" | "undecided";

export interface AcceptanceResult {
  verdict: AcceptanceVerdict;
  /** Minden megsértett vagy nem teljesült feltétel, emberi nyelven. */
  reasons: string[];
  budget: FrozenBudget;
  protocolVersion: string;
}

/**
 * Az elfogadás eldöntése. SORREND SZÁMÍT:
 *   1. túl kevés kötés → NEM ELDÖNTHETŐ (nem bukás),
 *   2. keretsértés (drawdown, költség, kitettség) → ELUTASÍTVA, bármilyen hozam mellett,
 *   3. a vak alapvonal felülmúlása a rögzített többlettel → ELFOGADHATÓ jelölt.
 *
 * „Elfogadható jelölt" ≠ „bekapcsolva": az adoptálás felhasználói kockázatdöntés.
 */
export function evaluateAcceptance(input: AcceptanceInput, budget: FrozenBudget = FROZEN_BUDGET): AcceptanceResult {
  const reasons: string[] = [];
  const base = { budget, protocolVersion: PROTOCOL_VERSION };

  if (input.closedTrades < budget.minClosedTrades) {
    reasons.push(
      `Csak ${input.closedTrades} lezárt kötés (a keret ${budget.minClosedTrades}) — a minta nem elég a döntéshez.`,
    );
    return { verdict: "undecided", reasons, ...base };
  }

  if (input.maxDrawdownPct > budget.maxDrawdownPct) {
    reasons.push(
      `A lehúzás ${(input.maxDrawdownPct * 100).toFixed(1)}%, a keret ${(budget.maxDrawdownPct * 100).toFixed(1)}%.`,
    );
  }
  const costPct = input.finalEquityUsd > 0 ? input.totalFeesUsd / input.finalEquityUsd : Number.POSITIVE_INFINITY;
  if (costPct > budget.maxCostBudgetPct) {
    reasons.push(
      `A költség a záró tőke ${(costPct * 100).toFixed(2)}%-a, a keret ${(budget.maxCostBudgetPct * 100).toFixed(2)}%.`,
    );
  }
  if (input.exposurePct > budget.maxExposurePct) {
    reasons.push(
      `A kitettség ${(input.exposurePct * 100).toFixed(1)}%, a keret ${(budget.maxExposurePct * 100).toFixed(1)}%.`,
    );
  }
  if (reasons.length > 0) return { verdict: "reject", reasons, ...base };

  const edge = input.netReturnPct - input.baselineReturnPct;
  if (edge < budget.minEdgeOverBaselinePct) {
    reasons.push(
      `A vak alapvonalhoz képest ${(edge * 100).toFixed(2)} százalékpont a többlet, ` +
        `a küszöb ${(budget.minEdgeOverBaselinePct * 100).toFixed(2)}.`,
    );
    return { verdict: "reject", reasons, ...base };
  }

  reasons.push(
    `Minden keret teljesül, és a többlet a vak alapvonalhoz képest ${(edge * 100).toFixed(2)} százalékpont.`,
  );
  return { verdict: "accept", reasons, ...base };
}

// ────────────────────────────────────────────────────────────────────────────────
// 6) Érvényesség és ujjlenyomat
// ────────────────────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  experimentId: string;
  variantId?: string;
  message: string;
}

/**
 * Egy kísérlet érvényessége. Amit ellenőriz:
 *  - van „baseline" változat, és az PONTOSAN a `DEFAULT_STRATEGY`,
 *  - minden más változat KIZÁRÓLAG a megnevezett tengelyen tér el,
 *  - a változat-azonosítók egyediek,
 *  - a kockázatot lazító változat jelölve van.
 */
export function validateExperiment(exp: Experiment): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  const baseline = exp.variants.find((v) => v.id === "baseline");
  if (!baseline) {
    issues.push({ experimentId: exp.id, message: "Nincs 'baseline' változat — nincs mihez viszonyítani." });
  } else if (strategyDiff(baseline.strategy, DEFAULT_STRATEGY).length > 0) {
    issues.push({
      experimentId: exp.id,
      variantId: "baseline",
      message: "A baseline nem azonos a DEFAULT_STRATEGY-vel, tehát nem a futó rendszert méri.",
    });
  }

  for (const v of exp.variants) {
    if (seen.has(v.id)) issues.push({ experimentId: exp.id, variantId: v.id, message: "Ismétlődő változat-azonosító." });
    seen.add(v.id);

    const diff = strategyDiff(v.strategy, DEFAULT_STRATEGY);
    const offAxis = diff.filter((k) => !exp.axis.includes(k));
    if (offAxis.length > 0) {
      issues.push({
        experimentId: exp.id,
        variantId: v.id,
        message: `A tengelyen KÍVÜL is eltér: ${offAxis.join(", ")}. Egy kísérlet egy kérdést vizsgál.`,
      });
    }
    if (v.raisesRisk !== isRiskier(v.strategy, DEFAULT_STRATEGY)) {
      issues.push({
        experimentId: exp.id,
        variantId: v.id,
        message: "A raisesRisk jelölés nem egyezik a tényleges kockázati iránnyal.",
      });
    }
  }
  return issues;
}

/** Minden kísérlet érvényessége egyben. */
export function validateProtocol(experiments: Experiment[] = EXPERIMENTS): ValidationIssue[] {
  return experiments.flatMap(validateExperiment);
}

/**
 * A fagyasztott protokoll ujjlenyomata (FNV-1a). A mérési jelentés ezt hordozza: ha
 * valaki UTÓLAG hozzányúl egy küszöbhöz vagy egy változathoz, a hash elmozdul, és a
 * régi jelentés nem állítható be az új protokoll eredményének.
 */
/**
 * KOCKÁZATEMELŐ VÁLTOZATOK KIFEJEZETT JÓVÁHAGYÁSA.
 *
 * A protokoll alapszabálya, hogy kockázatemelés nem csúszhat be „mellékesen". Ez a lista
 * NEM gyengíti a szabályt: attól, hogy egy változat itt szerepel, még jelölt marad —
 * csak azt rögzíti, hogy a lazítás TUDATOS felhasználói döntés volt, mikor és mi alapján.
 * Ami nincs a listán és emel kockázatot, az hiba.
 */
export const RISK_APPROVALS: Record<string, { approvedOn: string; by: string; rationale: string }> = {
  "E6-risk-ladder-L2/L2": {
    approvedOn: "2026-09-06",
    by: "felhasználó (kifejezett kérés: próbáljuk meg több kockázattal; majd: igen indítsd az L2-t)",
    rationale:
      "A kockázat-létra mérésén L2 volt az EGYETLEN lépcső, amely mindkét rezsimben javított: " +
      "medvepiacon -9.0% (alapvonal -0.1%, buy & hold BTC -44.5%), bikapiacon +17.0% (alapvonal +4.7%), " +
      "a teljes ~14 hónapon kamatosan +6.5% (alapvonal +4.6%). A mérés PAPÍRON fut, valós pénz nélkül.",
  },
};

/** Kockázatemelő változat jóváhagyás nélkül — ez a lista mindig üres kell legyen. */
export function unapprovedRiskyVariants(): string[] {
  return EXPERIMENTS.flatMap((e) =>
    e.variants.filter((v) => v.raisesRisk).map((v) => `${e.id}/${v.id}`),
  ).filter((key) => !RISK_APPROVALS[key]);
}

export function protocolHash(): string {
  const payload = JSON.stringify({
    PROTOCOL_VERSION,
    STRATEGY_VERSION,
    FROZEN_BUDGET,
    FROZEN_WINDOW,
    COST_SCENARIOS,
    CAPITAL_SCENARIOS,
    EXIT_CADENCES_MIN,
    EXPERIMENTS: EXPERIMENTS.map((e) => ({
      id: e.id,
      axis: e.axis,
      variants: e.variants.map((v) => ({ id: v.id, strategy: v.strategy })),
    })),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Emberi olvasásra: mi van befagyasztva. A jelentés fejléce ebből készül. */
export function describeProtocol(): string {
  const lines = [
    `Protokoll: ${PROTOCOL_VERSION} (hash ${protocolHash()})`,
    `Stratégia-verzió: ${STRATEGY_VERSION}`,
    `Keret: max lehúzás ${(FROZEN_BUDGET.maxDrawdownPct * 100).toFixed(0)}%, ` +
      `költség ≤ ${(FROZEN_BUDGET.maxCostBudgetPct * 100).toFixed(0)}%, ` +
      `kitettség ≤ ${(FROZEN_BUDGET.maxExposurePct * 100).toFixed(0)}%, ` +
      `min. ${FROZEN_BUDGET.minClosedTrades} lezárt kötés, ` +
      `min. többlet ${(FROZEN_BUDGET.minEdgeOverBaselinePct * 100).toFixed(0)} százalékpont`,
    `Ablak: ${FROZEN_WINDOW.symbols.join(", ")}, ${FROZEN_WINDOW.requestedDays} nap, ` +
      `holdout ${(FROZEN_WINDOW.holdoutRatio * 100).toFixed(0)}% (EGYSZERI mérés)`,
    `Kísérletek: ${EXPERIMENTS.map((e) => e.id).join(", ")}`,
    `Kontrollok: ${CONTROLS.map((c) => c.id).join(", ")}`,
  ];
  return lines.join("\n");
}

// Közvetlen futtatásnál kiírja a fagyasztott protokollt (a jelentésbe másolható).
if (process.argv[1] && process.argv[1].includes("experiment-configs")) {
  const issues = validateProtocol();
  console.log(describeProtocol());
  if (issues.length > 0) {
    console.error("\nÉRVÉNYTELEN PROTOKOLL:");
    for (const i of issues) console.error(`  - [${i.experimentId}${i.variantId ? `/${i.variantId}` : ""}] ${i.message}`);
    process.exit(1);
  }
  console.log("\nA protokoll érvényes: minden változat csak a saját tengelyén tér el.");
}

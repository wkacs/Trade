import type { CycleAction } from "@/lib/engine/tick";

/** Egy trade hajtóereje. */
export type TradeOrigin = "dca" | "stop-loss" | "take-profit" | "momentum" | "ai" | "manual";

/**
 * A tickenkénti teljes folyamat pillanatképe (a tick_runs.process JSON alakja).
 *
 * T23: a `health` blokk teszi láthatóvá, MIÉRT nem történt semmi. A hiányzó adat nem
 * nulla: a null és a 0 különbözik, és a naplóban is annak látszik.
 */
export interface TickProcess {
  tickId: string;
  inputs: {
    prices: Record<string, number>;
    fearGreed: { value: number; classification: string } | null;
    mlSignals: { symbol: string; direction1h: string; confidence: number }[];
  };
  cycleActions: { kind: "stop-loss" | "take-profit" | "dca" | "momentum"; side: "BUY" | "SELL"; symbol: string; qty?: number; amountUsd?: number }[];
  phase1: { shouldDecide: boolean; summary: string };
  phase2: { action: "BUY" | "SELL" | "HOLD"; symbol: string | null; amountPct: number; confidence: number; reasoning: string } | null;
  decision: { action: "BUY" | "SELL" | "HOLD"; symbol: string | null; overridden: boolean; overrideReason: string | null };
  trades: { symbol: string; side: "BUY" | "SELL"; origin: TradeOrigin; amountUsd: number }[];
  /** Futási állapot és adatminőség. Hiányzó adat = null, NEM nulla. */
  health?: TickHealth;
}

export interface TickHealth {
  /** Köthetett volna-e egyáltalán ez a tick? */
  tradingEnabled: boolean;
  /** Miért nem kereskedünk, ha nem. */
  blockedReason: string | null;
  /** A végrehajtási ár kora ms-ban. null = nem mérhető. */
  quoteAgeMs: number | null;
  quotesDegraded: boolean;
  /** Elavult vagy hiányzó ár miatt kihagyott orderek. */
  staleSkips: { symbol: string; side: string; reason: string; ageMs: number | null }[];
  /** Beküldés előtti ár-frissítések (az LLM-szakasz alatt elöregedett quote pótlása). */
  quoteRefreshes?: { symbol: string; beforeAgeMs: number | null; afterAgeMs: number | null; ok: boolean }[];
  /** Forrásonkénti kimenetel (melyik adott adatot, mennyi idő alatt, milyen hibával). */
  collectors: { name: string; ok: boolean; points: number; durationMs: number; error?: string | null }[];
  /** Adat-elégségesség symbolonként (a stratégia visszatekintéséhez). */
  signals: Record<string, { bars: number; requiredBars: number; sufficient: boolean }>;
  /** Az ML-modell állapota. `usable: false` → NINCS ML-jel, nem „semleges" jel. */
  ml: { usable: boolean; detail: string | null; signalCount: number };
  /** Napi kapu: forrás, napi hozam (null = nem mérhető), latch. */
  dayGate: { source: string; dayPnlPct: number | null; latched: boolean; blockNewBuys: boolean };
  /** Az LLM mérhető költsége (phase-2). null = nem volt hívás; a hiányzó tokenszám NEM nulla. */
  llm: { model: string; promptVersion: string; latencyMs: number; totalTokens: number | null; failed: boolean } | null;
  /** A phase-1 szűrő hívása. Enélkül a bukott szűrő „nyugodt órának" látszana. */
  llmPhase1?: {
    model: string;
    promptVersion: string;
    latencyMs: number;
    totalTokens: number | null;
    failed: boolean;
    errorCode?: string;
  } | null;
  /** Az egyes szakaszok időtartama ms-ban (stage latency). */
  stageMs: Record<string, number>;
}

export interface TickProcessInput {
  tickId: string;
  prices: Record<string, number>;
  fearGreed: { value: number; classification: string } | null;
  mlSignals: { symbol: string; direction1h: string; confidence: number }[];
  cycleActions: CycleAction[];
  phase1: { shouldDecide: boolean; summary: string };
  phase2: TickProcess["phase2"];
  decision: TickProcess["decision"];
  aiTrade: { symbol: string; side: "BUY" | "SELL"; amountUsd: number } | null;
  health?: TickHealth;
}

/**
 * Tiszta összeállító: a runTick belsőkből egységes TickProcess-t épít. A cycleActions
 * MAGUK a végrehajtott profit-ciklus trade-ek (kind = origin); az AI-trade 'ai' eredettel
 * a végükre kerül. Nincs IO/Date/Math.random.
 */
export function buildTickProcess(input: TickProcessInput): TickProcess {
  const cycleTrades = input.cycleActions.map((a) => ({
    symbol: a.symbol,
    side: a.side,
    origin: a.kind as TradeOrigin,
    amountUsd: a.amountUsd ?? 0,
  }));
  const aiTrades = input.aiTrade
    ? [{ symbol: input.aiTrade.symbol, side: input.aiTrade.side, origin: "ai" as TradeOrigin, amountUsd: input.aiTrade.amountUsd }]
    : [];
  return {
    tickId: input.tickId,
    inputs: { prices: input.prices, fearGreed: input.fearGreed, mlSignals: input.mlSignals },
    cycleActions: input.cycleActions.map((a) => ({ kind: a.kind, side: a.side, symbol: a.symbol, qty: a.qty, amountUsd: a.amountUsd })),
    phase1: input.phase1,
    phase2: input.phase2,
    decision: input.decision,
    trades: [...cycleTrades, ...aiTrades],
    ...(input.health ? { health: input.health } : {}),
  };
}

/**
 * Emberi olvasásra szánt összefoglaló arról, MIÉRT nem történt kötés. Ha nincs ilyen ok,
 * üres tömb — nem találunk ki magyarázatot.
 */
export function explainNoTrade(process: TickProcess): string[] {
  const reasons: string[] = [];
  const h = process.health;
  if (process.trades.length > 0) return reasons;
  if (h) {
    if (!h.tradingEnabled) reasons.push(h.blockedReason ?? "Nincs hiteles portfólió-állapot.");
    if (h.dayGate.latched) reasons.push("Napi veszteségkapu aktív — új vétel a következő UTC napig tiltott.");
    if (h.dayGate.dayPnlPct === null) reasons.push("Nincs hiteles napkezdő equity-referencia.");
    for (const s of h.staleSkips) reasons.push(`${s.symbol} ${s.side}: a végrehajtási ár ${s.reason}.`);
    for (const [sym, sig] of Object.entries(h.signals)) {
      if (!sig.sufficient) reasons.push(`${sym}: kevés hézagmentes gyertya (${sig.bars}/${sig.requiredBars}).`);
    }
    if (!h.ml.usable && h.ml.detail) reasons.push(`ML-jel kihagyva: ${h.ml.detail}`);
    for (const c of h.collectors) {
      if (!c.ok) reasons.push(`Adatforrás hiba: ${c.name}${c.error ? ` — ${c.error}` : ""}.`);
    }
  }
  // A bukott phase-1 NEM ugyanaz, mint egy nyugodt óra: a HOLD ilyenkor hiba, nem ítélet.
  if (h?.llmPhase1?.failed) {
    reasons.push(
      `A phase-1 LLM-hívás hibázott (${h.llmPhase1.errorCode ?? "ismeretlen"}, ${h.llmPhase1.latencyMs} ms) — a ciklus HOLD-ra esett vissza.`,
    );
  } else if (!process.phase1.shouldDecide) {
    reasons.push("A phase-1 szűrő szerint nem volt döntésre érdemes esemény.");
  }
  if (process.decision.overridden && process.decision.overrideReason) {
    reasons.push(`Kockázati kapu: ${process.decision.overrideReason}`);
  }
  return reasons;
}

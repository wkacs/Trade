import type { CycleAction } from "@/lib/engine/tick";

/** Egy trade hajtóereje. */
export type TradeOrigin = "dca" | "stop-loss" | "take-profit" | "momentum" | "ai" | "manual";

/** A tickenkénti teljes folyamat pillanatképe (a tick_runs.process JSON alakja). */
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
  };
}

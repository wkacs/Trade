import type { RawDecision, Decision } from "@/lib/types";

export interface RiskContext {
  cashUsd: number;
  positions: { symbol: string; valueUsd: number }[];
  totalEquity: () => number;
  /** Mai napi P&L % (circuit breakerhez). Pozitív = nyereség, negatív = veszteség. */
  dayPnlPct?: number;
}

export interface RiskParams {
  maxPositionPct: number;
  maxConcurrentPositions: number;
  dailyLossCircuitBreakerPct: number;
}

/**
 * A Risk Manager az AI döntése felett áll — minden order kötelezően átmegy rajta.
 * Konzervatív limiteket érvényesít: napi circuit breaker, max pozíció %, max egyidejű
 * pozíció. A heti DCA-keret kapu KIKERÜLT innen (lásd tournament spec §6): a heti
 * keret csak az automatikus DCA-t fékezi, az AI saját BUY-ját NEM → nincs HOLD-fagyás.
 */
export function applyRisk(raw: RawDecision, ctx: RiskContext, params: RiskParams): Decision {
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  const base: Decision = { ...raw, id, timestamp, overridden: false };

  // HOLD mindig átengedve
  if (raw.action === "HOLD") return base;

  // 1) Circuit breaker: napi veszteség-küszöb után csak HOLD
  if ((ctx.dayPnlPct ?? 0) <= -params.dailyLossCircuitBreakerPct) {
    return {
      ...base,
      action: "HOLD",
      overridden: true,
      overrideReason: `Napi circuit breaker aktiválódott (${(ctx.dayPnlPct! * 100).toFixed(1)}% < -${(
        params.dailyLossCircuitBreakerPct * 100
      ).toFixed(0)}%)`,
    };
  }

  // 2) Max pozíció: BUY amountPct visszavágása
  if (raw.action === "BUY" && raw.amountPct > params.maxPositionPct) {
    return {
      ...base,
      amountPct: params.maxPositionPct,
      overridden: true,
      overrideReason: `Max pozíció ${(params.maxPositionPct * 100).toFixed(0)}% tőke — visszavágva ${(
        raw.amountPct * 100
      ).toFixed(0)}%-ról`,
    };
  }

  // 3) Max egyidejű pozíció (csak ha ÚJ coinra nyitunk)
  const openSymbols = new Set(ctx.positions.map((p) => p.symbol));
  const isNewPosition = raw.action === "BUY" && raw.symbol && !openSymbols.has(raw.symbol);
  if (isNewPosition && openSymbols.size >= params.maxConcurrentPositions) {
    return {
      ...base,
      action: "HOLD",
      overridden: true,
      overrideReason: `Max ${params.maxConcurrentPositions} egyidejű pozíció — új coin nyitás elutasítva`,
    };
  }

  return base;
}

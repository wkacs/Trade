import { RISK_LIMITS } from "@/lib/config";
import type { RawDecision, Decision } from "@/lib/types";

export interface RiskContext {
  cashUsd: number;
  positions: { symbol: string; valueUsd: number }[];
  totalEquity: () => number;
  /** Mai napi P&L % (circuit breakerhez). Pozitív = nyereség, negatív = veszteség. */
  dayPnlPct?: number;
}

/**
 * A Risk Manager az AI döntése felett áll — minden order kötelezően átmegy rajta.
 * Konzervatív limiteket érvényesít. Ha az AI túl merészet javasol, módosít vagy HOLD-ra vált.
 * Lásd spec §3.4. Minden override naplózva lesz a risk_overrides táblába.
 */
export function applyRisk(raw: RawDecision, ctx: RiskContext): Decision {
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  const base: Decision = { ...raw, id, timestamp, overridden: false };

  // HOLD mindig átengedve
  if (raw.action === "HOLD") return base;

  // 1) Circuit breaker: napi -3% után csak HOLD
  if ((ctx.dayPnlPct ?? 0) <= -RISK_LIMITS.dailyLossCircuitBreakerPct) {
    return {
      ...base,
      action: "HOLD",
      overridden: true,
      overrideReason: `Napi circuit breaker aktiválódott (${(ctx.dayPnlPct! * 100).toFixed(1)}% < -3%)`,
    };
  }

  // 2) Max pozíció 20%: BUY amountPct visszavágása
  if (raw.action === "BUY" && raw.amountPct > RISK_LIMITS.maxPositionPct) {
    return {
      ...base,
      amountPct: RISK_LIMITS.maxPositionPct,
      overridden: true,
      overrideReason: `Max pozíció 20% tőke — visszavágva ${(raw.amountPct * 100).toFixed(0)}%-ról`,
    };
  }

  // 3) Max 3 egyidejű pozíció (csak ha ÚJ coinra nyitunk)
  const openSymbols = new Set(ctx.positions.map((p) => p.symbol));
  const isNewPosition = raw.action === "BUY" && raw.symbol && !openSymbols.has(raw.symbol);
  if (isNewPosition && openSymbols.size >= RISK_LIMITS.maxConcurrentPositions) {
    return {
      ...base,
      action: "HOLD",
      overridden: true,
      overrideReason: `Max ${RISK_LIMITS.maxConcurrentPositions} egyidejű pozíció — új coin nyitás elutasítva`,
    };
  }

  return base;
}

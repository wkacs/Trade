"use client";

export interface RiskConfig {
  maxPositionPct: number;
  stopLossPct: number;
  maxConcurrentPositions: number;
  dailyLossCircuitBreakerPct: number;
  takeProfitPct: number;
  dcaFgThreshold: number;
  dcaWeeklyBudgetPct: number;
  dcaBuyPct: number;
}

/** Kockázati + stratégia-limitek (hardcoded) + a heti DCA-keret aktuális maradéka. */
export function RiskPanel({
  config,
  weeklyBudgetRemainingUsd,
}: {
  config: RiskConfig | null;
  weeklyBudgetRemainingUsd: number | null;
}) {
  const rows: [string, string][] = config
    ? [
        ["max pozíció", `${(config.maxPositionPct * 100).toFixed(0)}% tőke`],
        ["stop-loss", `-${(config.stopLossPct * 100).toFixed(0)}%`],
        ["take-profit", `+${(config.takeProfitPct * 100).toFixed(0)}% (fél pozíció)`],
        ["max pozíció-szám", `${config.maxConcurrentPositions}`],
        ["napi circuit breaker", `-${(config.dailyLossCircuitBreakerPct * 100).toFixed(0)}%`],
        ["DCA küszöb", `F&G ≤ ${config.dcaFgThreshold}`],
        ["DCA vétel", `${(config.dcaBuyPct * 100).toFixed(0)}% tőke`],
        ["heti DCA-keret", `${(config.dcaWeeklyBudgetPct * 100).toFixed(0)}% tőke`],
      ]
    : [];

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
        Kockázat / stratégia
      </h2>
      <dl className="mt-3 space-y-1.5 font-mono text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="text-faint">{k}</dt>
            <dd className="tabular-nums text-dim">{v}</dd>
          </div>
        ))}
        <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
          <dt className="text-faint">heti keret maradt</dt>
          <dd className="tabular-nums text-accentBright">
            {weeklyBudgetRemainingUsd == null ? "—" : `$${weeklyBudgetRemainingUsd.toFixed(2)}`}
          </dd>
        </div>
      </dl>
    </section>
  );
}

"use client";

import type { RiskConfig } from "./RiskPanel";

/** Statikus magyarázó: MIT csinál a hangolt stratégia (emberi nyelvű szabály-lista). */
export function StrategyPanel({ config }: { config: RiskConfig | null }) {
  if (!config) return null;
  const pct = (n?: number) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
  const rules: [string, string][] = [
    ["Belépő-szűrő", config.entryFilter === "trend" ? "BE — csak emelkedő trendben vásárol (SMA24)" : "KI"],
    ["Take-profit", `+${pct(config.takeProfitPct)} → ${config.takeProfitFraction === 1 ? "teljes" : "fél"} pozíció zárása`],
    ["DCA (halmozás)", `Fear & Greed ≤ ${config.dcaFgThreshold} esetén ${pct(config.dcaBuyPct)} vétel, heti ${pct(config.dcaWeeklyBudgetPct)} keret`],
    ["Stop-loss", `−${pct(config.stopLossPct)} (trailing: emelkedéskor felfelé kúszik)`],
    ["Max pozíció", `${pct(config.maxPositionPct)} tőke / coin, max ${config.maxConcurrentPositions} egyszerre`],
    ["Napi circuit breaker", `−${pct(config.dailyLossCircuitBreakerPct)} alatt új vétel tiltva`],
  ];
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
        Stratégia — a bot szabályai
      </h2>
      <dl className="mt-3 space-y-2">
        {rules.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 border-b border-line/40 pb-2 last:border-0">
            <dt className="font-mono text-[10px] uppercase tracking-wider text-faint">{k}</dt>
            <dd className="font-sans text-[12.5px] text-dim">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

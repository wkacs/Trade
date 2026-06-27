"use client";

export interface MlSignalView {
  symbol: string;
  direction1h: "up" | "down" | "flat";
  confidence: number;
}

export interface PerfView {
  evaluated: number;
  actionable: number;
  hitRate: number | null;
  avgHypotheticalPnlPct: number;
}

/** ML-jel (per-coin irány/bizonyosság + modell AUC) + a döntés-kiértékelés összesítője. */
export function MarketPanel({
  signals,
  mlAuc,
  performance,
}: {
  signals: MlSignalView[];
  mlAuc: number | null;
  performance?: PerfView;
}) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
        ML-jel / teljesítmény
      </h2>

      <div className="mt-3 flex items-baseline justify-between font-mono text-xs">
        <span className="text-faint">modell AUC (out-of-sample)</span>
        <span className="tabular-nums text-dim">{mlAuc == null ? "—" : mlAuc.toFixed(3)}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
        {signals.length === 0 && <span className="text-faint">nincs jel</span>}
        {signals.map((s) => {
          const flat = s.direction1h === "flat";
          const up = s.direction1h === "up";
          return (
            <span key={s.symbol}>
              <span className="text-faint">{s.symbol}</span>{" "}
              <span className={`tabular-nums ${flat ? "text-dim" : up ? "text-up" : "text-down"}`}>
                {flat ? "■" : up ? "▴" : "▾"}
                {s.confidence.toFixed(2)}
              </span>
            </span>
          );
        })}
      </div>

      {performance && (
        <div className="mt-3 border-t border-line pt-2 font-mono text-[11px] text-faint">
          kiértékelt <span className="text-dim">{performance.evaluated}</span> · hit{" "}
          <span className="text-dim">
            {performance.hitRate == null ? "—" : `${Math.round(performance.hitRate * 100)}%`}
          </span>{" "}
          · átlag hipo{" "}
          <span className={performance.avgHypotheticalPnlPct >= 0 ? "text-up" : "text-down"}>
            {performance.avgHypotheticalPnlPct >= 0 ? "+" : ""}
            {performance.avgHypotheticalPnlPct.toFixed(2)}%
          </span>
        </div>
      )}
    </section>
  );
}

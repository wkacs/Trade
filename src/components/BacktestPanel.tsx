"use client";

import { useState } from "react";

interface BacktestResult {
  totalReturnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  hitRate: number;
  tradesCount: number;
}

/**
 * Backtest — a kód-profit-ciklus futtatása a történelmi Binance-adaton, gyertya-fill
 * szimulációval. A valós motort hívja (/api/backtest). Lásd backtest spec.
 */
export function BacktestPanel() {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setNote(null);
    try {
      const r = await fetch("/api/backtest");
      const d = await r.json();
      if (d.error) {
        setNote("A backtest nem futott le. Próbáld újra.");
        setResult(null);
      } else {
        setResult({
          totalReturnPct: d.totalReturnPct,
          sharpe: d.sharpe,
          maxDrawdownPct: d.maxDrawdownPct,
          hitRate: d.hitRate,
          tradesCount: d.tradesCount,
        });
      }
    } catch {
      setNote("A backtest nem futott le. Próbáld újra.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
        Backtest
      </h2>
      <p className="mt-1 font-sans text-xs text-dim">
        Futtasd a kód-profit-ciklust a történelmi adatokon, mielőtt élesre váltanál.
      </p>
      <button
        onClick={run}
        disabled={loading}
        className="mt-3 rounded-lg border border-iris/30 bg-iris/10 px-3.5 py-1.5 font-mono text-xs text-irisBright transition-colors hover:bg-iris/20 disabled:opacity-50"
      >
        {loading ? "fut…" : "futtatás"}
      </button>
      {result && (
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-sm">
          <Metric label="hozam" value={`${(result.totalReturnPct * 100).toFixed(2)}%`} good={result.totalReturnPct >= 0} />
          <Metric label="Sharpe" value={result.sharpe.toFixed(2)} good={result.sharpe >= 0} />
          <Metric label="max DD" value={`-${(result.maxDrawdownPct * 100).toFixed(1)}%`} good={false} />
          <Metric label="hit rate" value={`${(result.hitRate * 100).toFixed(0)}%`} />
          <span className="col-span-2 text-faint">{result.tradesCount} lezárt trade</span>
        </div>
      )}
      {note && <p className="mt-3 font-mono text-[11px] text-amber-400/70">{note}</p>}
    </section>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  const color = good === undefined ? "text-fg" : good ? "text-up" : "text-down";
  return (
    <span className="flex items-baseline justify-between gap-2">
      <span className="text-faint text-xs">{label}</span>
      <span className={color}>{value}</span>
    </span>
  );
}

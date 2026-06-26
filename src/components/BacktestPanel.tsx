"use client";

import { useState } from "react";

interface BacktestResult {
  pnlPct: number;
  tradesCount: number;
}

/**
 * Backtest — a stratégia futtatása a történelmi adatokon. Lásd spec §3.5.
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
      if (d.note) {
        setNote(d.note);
        setResult(null);
      } else {
        setResult({ pnlPct: d.pnlPct, tradesCount: d.tradesCount });
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
        Futtasd a stratégiát a történelmi adatokon, mielőtt élesre váltanál.
      </p>
      <button
        onClick={run}
        disabled={loading}
        className="mt-3 rounded-lg border border-iris/30 bg-iris/10 px-3.5 py-1.5 font-mono text-xs text-irisBright transition-colors hover:bg-iris/20 disabled:opacity-50"
      >
        {loading ? "fut…" : "futtatás"}
      </button>
      {result && (
        <div className="mt-4 flex items-baseline gap-4 font-mono text-sm">
          <span className={result.pnlPct >= 0 ? "text-up" : "text-down"}>
            {(result.pnlPct * 100).toFixed(2)}%
          </span>
          <span className="text-faint">{result.tradesCount} tranzakció</span>
        </div>
      )}
      {note && <p className="mt-3 font-mono text-[11px] text-amber-400/70">{note}</p>}
    </section>
  );
}

"use client";

import { useState } from "react";

interface BacktestResult {
  pnlPct: number;
  tradesCount: number;
}

/**
 * Backtest panel — gombnyomásra futtat egy stratégiát a történelmi adatokon.
 * Lásd spec §3.5. Az /api/backtest route-t hívja.
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
      setNote("Backtest futtatása sikertelen.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Backtest</h2>
      <p className="mt-1 text-xs text-gray-500">
        Teszteld az AI stratégiáját a történelmi adatokon, mielőtt valós módba váltanál.
      </p>
      <button
        onClick={run}
        disabled={loading}
        className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Fut…" : "Backtest futtatása"}
      </button>
      {result && (
        <div className="mt-4 text-sm">
          <div>
            Eredmény:{" "}
            <span className={result.pnlPct >= 0 ? "text-green-600" : "text-red-600"}>
              {(result.pnlPct * 100).toFixed(2)}%
            </span>
          </div>
          <div className="text-gray-500">Tranzakciók: {result.tradesCount}</div>
        </div>
      )}
      {note && <p className="mt-3 text-xs text-amber-600">{note}</p>}
    </div>
  );
}

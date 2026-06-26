"use client";

import { useEffect, useState } from "react";
import { PortfolioPanel } from "./PortfolioPanel";
import { DecisionsTimeline } from "./DecisionsTimeline";
import { BacktestPanel } from "./BacktestPanel";
import { AdminPanel } from "./AdminPanel";

interface PortfolioApi {
  portfolio: { cashUsd: number; initialCapitalUsd: number } | null;
  positions: { symbol: string; qty: number; entryPrice: number }[];
  recentTrades: unknown[];
  performance?: {
    evaluated: number;
    actionable: number;
    hitRate: number | null;
    avgHypotheticalPnlPct: number;
  };
  note?: string;
}

/**
 * A fő dashboard — egyetlen oldal, a döntés-érthetőség fókuszával.
 * Lásd spec §3.5. Betölti a portfóliót és összeállítja a paneleket.
 */
export function Dashboard() {
  const [portfolio, setPortfolio] = useState<PortfolioApi | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/portfolio")
      .then((r) => r.json())
      .then(setPortfolio)
      .catch(() => setPortfolio(null))
      .finally(() => setLoading(false));
  }, []);

  // Alapértelmezett demo állapot, ha nincs DB
  const cashUsd = portfolio?.portfolio?.cashUsd ?? 10000;
  const positions = portfolio?.positions ?? [];
  const perf = portfolio?.performance;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">AI Kereskedő Bot</h1>
        <p className="mt-1 text-sm text-gray-500">
          Hibrid AI (LightGBM + GLM) által vezérelt kripto-trading ·{" "}
          <span className="font-medium text-gray-700">demo (paper) mód</span>
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-gray-400">Betöltés…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <PortfolioPanel cashUsd={cashUsd} positions={positions} />
          <AdminPanel />
        </div>
      )}

      {perf && perf.evaluated > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Bejött volna? (utólagos kiértékelés)</h2>
          <p className="mt-1 text-xs text-gray-500">
            A korábbi döntések szándéka utólag, az árak alapján — mintha tényleg kötött volna.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-gray-500">Találati arány</div>
              <div className="text-xl font-semibold text-blue-600">
                {perf.hitRate === null ? "—" : `${Math.round(perf.hitRate * 100)}%`}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Átlag hipotetikus P&L</div>
              <div className={`text-xl font-semibold ${perf.avgHypotheticalPnlPct >= 0 ? "text-green-700" : "text-red-600"}`}>
                {perf.avgHypotheticalPnlPct >= 0 ? "+" : ""}
                {perf.avgHypotheticalPnlPct.toFixed(2)}%
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Kiértékelt / döntésre váró</div>
              <div className="text-xl font-semibold text-gray-900">
                {perf.actionable} / {perf.evaluated}
              </div>
            </div>
          </div>
        </div>
      )}

      <DecisionsTimeline />
      <BacktestPanel />

      <footer className="pt-4 text-center text-xs text-gray-400">
        BTC · ETH · SOL (USDT) · konzervatív limitek · spec:{" "}
        <code>docs/superpowers/specs/2026-06-25-ai-crypto-trader-design.md</code>
      </footer>
    </main>
  );
}

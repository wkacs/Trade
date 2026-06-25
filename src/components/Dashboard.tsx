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

      <DecisionsTimeline />
      <BacktestPanel />

      <footer className="pt-4 text-center text-xs text-gray-400">
        BTC · ETH · SOL (USDT) · konzervatív limitek · spec:{" "}
        <code>docs/superpowers/specs/2026-06-25-ai-crypto-trader-design.md</code>
      </footer>
    </main>
  );
}

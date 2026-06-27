"use client";

import { useCallback, useEffect, useState } from "react";
import { PortfolioPanel } from "./PortfolioPanel";
import { DecisionsTimeline } from "./DecisionsTimeline";
import { BacktestPanel } from "./BacktestPanel";
import { AdminPanel } from "./AdminPanel";
import model from "@/lib/ml/model.json";

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

const fmtUsd = (n: number) => `$${n.toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * A fő konzol — egyetlen oldal, „műszerfal / döntés-napló". A bot lényege a látható
 * AI-érvelés, ezért a döntés-napló a főszereplő. Lásd spec §3.5.
 */
export function Dashboard() {
  const [data, setData] = useState<PortfolioApi | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetch("/api/portfolio")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  // Élő érzet: 60 mp-enként frissít (a tick óránként fut, de így sosem áll).
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const initial = data?.portfolio?.initialCapitalUsd ?? 0;
  const cashUsd = data?.portfolio?.cashUsd ?? 0;
  const positions = data?.positions ?? [];
  const positionsValue = positions.reduce((s, p) => s + p.qty * p.entryPrice, 0);
  const equity = cashUsd + positionsValue;
  const pnlPct = initial > 0 ? (equity / initial - 1) * 100 : 0;
  const perf = data?.performance;
  const hasDb = !!data?.portfolio;
  const auc = (model as { metrics?: { testAuc?: number } }).metrics?.testAuc ?? 0;

  return (
    <div className="min-h-screen">
      {/* ── Státusz-sáv: a rendszer szívverése ── */}
      <header className="sticky top-0 z-10 border-b border-line bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="pulse-dot h-2 w-2 rounded-full bg-accent" aria-hidden />
            <span className="font-display text-sm font-bold tracking-[0.18em] text-ink">
              AI&nbsp;KERESKEDŐ
            </span>
            <span className="rounded border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-accentBright">
              {hasDb ? "paper" : "offline"}
            </span>
          </div>
          <div className="hidden items-center gap-5 font-mono text-[11px] text-faint sm:flex">
            <span>
              ML·AUC <span className="text-dim">{auc.toFixed(3)}</span>
            </span>
            <span className="text-line">/</span>
            <span>
              GLM <span className="text-dim">glm-4.7-flash</span>
            </span>
            <span className="text-line">/</span>
            <span className="text-dim">{loading ? "betöltés…" : "élő · 60s"}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-5 py-7">
        {/* ── Műszer-readout: equity + P&L + találati arány ── */}
        <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-4">
          <Gauge label="Equity" value={hasDb ? fmtUsd(equity) : "—"} accent />
          <Gauge
            label="P&L (kezdőtőke)"
            value={hasDb ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "—"}
            tone={pnlPct >= 0 ? "up" : "down"}
            muted={!hasDb || Math.abs(pnlPct) < 0.005}
          />
          <Gauge
            label="Találati arány"
            value={perf?.hitRate == null ? "—" : `${Math.round(perf.hitRate * 100)}%`}
            sub={perf ? `${perf.actionable} kötés-szándék` : undefined}
          />
          <Gauge
            label="Átlag hipo. P&L"
            value={perf && perf.actionable > 0 ? `${perf.avgHypotheticalPnlPct >= 0 ? "+" : ""}${perf.avgHypotheticalPnlPct.toFixed(2)}%` : "—"}
            tone={perf && perf.avgHypotheticalPnlPct >= 0 ? "up" : "down"}
            muted={!perf || perf.actionable === 0}
          />
        </section>

        {/* ── Portfólió (készpénz + pozíciók) ── */}
        <PortfolioPanel cashUsd={cashUsd} positions={positions} hasDb={hasDb} />

        {/* ── A főszereplő: a döntés-napló ── */}
        <DecisionsTimeline />

        {/* ── Másodlagos vezérlők ── */}
        <div className="grid gap-5 lg:grid-cols-2">
          <BacktestPanel />
          <AdminPanel />
        </div>

        <footer className="pt-2 text-center font-mono text-[11px] text-faint">
          BTC · ETH · SOL (USDT) &nbsp;·&nbsp; konzervatív limitek &nbsp;·&nbsp; hibrid: ML-jel + GLM-érvelés
        </footer>
      </main>
    </div>
  );
}

function Gauge({
  label,
  value,
  sub,
  accent,
  tone,
  muted,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  tone?: "up" | "down";
  muted?: boolean;
}) {
  const color = muted
    ? "text-ink"
    : accent
      ? "text-accentBright"
      : tone === "up"
        ? "text-up"
        : tone === "down"
          ? "text-down"
          : "text-ink";
  return (
    <div className="bg-panel px-5 py-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-faint">{label}</div>
      <div className={`mt-1.5 font-mono text-2xl tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-faint">{sub}</div>}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { PortfolioPanel } from "./PortfolioPanel";
import { DecisionsTimeline } from "./DecisionsTimeline";
import { BacktestPanel } from "./BacktestPanel";
import { AdminPanel } from "./AdminPanel";
import { TickerStrip } from "./TickerStrip";
import { RiskPanel, type RiskConfig } from "./RiskPanel";
import { StrategyPanel } from "./StrategyPanel";
import { TradeBlotter, type BlotterTrade } from "./TradeBlotter";
import { MarketPanel, type MlSignalView, type PerfView } from "./MarketPanel";
import { TickInspector } from "./TickInspector";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { ShadowPanel } from "./ShadowPanel";

interface StockLaneApi {
  initialized: boolean;
  cashUsd: number;
  quote: string;
  positions: { symbol: string; qty: number; entryPrice: number; stopPrice?: number }[];
}

interface PortfolioApi {
  portfolio: { cashUsd: number; initialCapitalUsd: number } | null;
  positions: { symbol: string; qty: number; entryPrice: number; stopPrice?: number }[];
  recentTrades: BlotterTrade[];
  performance?: PerfView;
  stock?: StockLaneApi;
  note?: string;
}

interface MarketApi {
  prices: Record<string, { usd: number; change24hPct: number }>;
  fearGreed: { value: number; classification: string } | null;
  signals: MlSignalView[];
  weeklyBudgetRemainingUsd: number | null;
  mlAuc: number | null;
  config: RiskConfig | null;
}

const fmtUsd = (n: number) =>
  `$${n.toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * A fő konzol — sűrű „trading terminál": sok élő adat az API-ból (árak, F&G, ML-jel,
 * pozíciók élő P&L-lel, döntés-napló teljes érveléssel, kockázati limitek, trade-napló).
 */
export function Dashboard() {
  const [data, setData] = useState<PortfolioApi | null>(null);
  const [market, setMarket] = useState<MarketApi | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetch("/api/portfolio", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    fetch("/api/market", { cache: "no-store" })
      .then((r) => r.json())
      .then((m) => (m.error ? null : setMarket(m)))
      .catch(() => setMarket(null));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const initial = data?.portfolio?.initialCapitalUsd ?? 0;
  const cashUsd = data?.portfolio?.cashUsd ?? 0;
  const positions = data?.positions ?? [];
  const prices = market?.prices;
  // Equity élő áron (ha van market), különben belépési áron.
  const positionsValue = positions.reduce(
    (s, p) => s + (prices?.[p.symbol]?.usd ?? p.entryPrice) * p.qty,
    0,
  );
  const equity = cashUsd + positionsValue;
  const pnlPct = initial > 0 ? (equity / initial - 1) * 100 : 0;
  const perf = data?.performance;
  // Irány-pontszám (NEM profit): csak pontozható döntésekre és csak ha tényleg szám.
  const dirScore =
    perf && perf.actionable > 0 && Number.isFinite(perf.avgDirectionalScorePct)
      ? perf.avgDirectionalScorePct
      : null;
  const hasDb = !!data?.portfolio;
  const fg = market?.fearGreed;

  // ── Részvény-sáv: SAJÁT, elkülönített USD-pénztárca (stock-paper scope) ──
  const stock = data?.stock;
  const stockPositions = stock?.positions ?? [];
  const stockCash = stock?.cashUsd ?? 0;
  // Élő részvény-ár-feed még nincs a UI-on; a pozíció belépési áron értékelődik.
  const stockValue = stockPositions.reduce((s, p) => s + p.entryPrice * p.qty, 0);
  const stockEquity = stockCash + stockValue;
  const stockReady = !!stock?.initialized;

  return (
    <div className="min-h-screen">
      {/* ── Command bar ── */}
      <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="pulse-dot h-2 w-2 rounded-full bg-accent" aria-hidden />
            <span className="font-display text-sm font-bold tracking-[0.18em] text-ink">
              AI&nbsp;▸&nbsp;TRADER
            </span>
            <span className="rounded border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-accentBright">
              {hasDb ? "paper" : "offline"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-faint">
            {fg && (
              <span>
                F&amp;G{" "}
                <span className={fg.value <= 25 ? "text-down" : fg.value >= 75 ? "text-up" : "text-dim"}>
                  {fg.value} · {fg.classification}
                </span>
              </span>
            )}
            <span className="text-line">/</span>
            <span>
              ML·AUC <span className="text-dim">{market?.mlAuc?.toFixed(3) ?? "—"}</span>
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

      <main className="mx-auto max-w-7xl space-y-4 px-5 py-6">
        {/* ══════════ 1. SÁV — KRIPTÓ (USDT, óránkénti) ══════════ */}
        <LaneHeader
          tone="accent"
          label="Kriptó"
          sub="BTC · ETH · SOL · USDT · óránkénti tick"
          status={hasDb ? "paper" : "offline"}
        />

        {/* ── Ticker ── */}
        {prices && <TickerStrip prices={prices} />}

        {/* ── KPI readout ── */}
        <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
          <Gauge label="Equity" value={hasDb ? fmtUsd(equity) : "—"} accent />
          <Gauge
            label="P&L (kezdő)"
            value={hasDb ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "—"}
            tone={pnlPct >= 0 ? "up" : "down"}
            muted={!hasDb || Math.abs(pnlPct) < 0.005}
          />
          <Gauge label="Készpénz" value={hasDb ? fmtUsd(cashUsd) : "—"} />
          <Gauge label="Pozíciók" value={hasDb ? String(positions.length) : "—"} />
          <Gauge
            label="Találati arány"
            value={perf?.hitRate == null ? "—" : `${Math.round(perf.hitRate * 100)}%`}
            sub={perf ? `${perf.actionable} szándék` : undefined}
          />
          <Gauge
            label="Átlag irány-pontszám"
            value={dirScore == null ? "—" : `${dirScore >= 0 ? "+" : ""}${dirScore.toFixed(2)}%`}
            tone={dirScore != null && dirScore < 0 ? "down" : "up"}
            muted={dirScore == null}
          />
        </section>

        {/* ── Fő rács: döntés-konzol (széles) + pozíciók/kockázat ── */}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <DecisionsTimeline />
          </div>
          <div className="space-y-4">
            <PortfolioPanel cashUsd={cashUsd} positions={positions} hasDb={hasDb} prices={prices} />
            <RiskPanel config={market?.config ?? null} weeklyBudgetRemainingUsd={market?.weeklyBudgetRemainingUsd ?? null} />
            <StrategyPanel config={market?.config ?? null} />
          </div>
        </div>

        {/* ── Trade-napló + ML-jel/teljesítmény ── */}
        <div className="grid gap-4 lg:grid-cols-2">
          <TradeBlotter trades={data?.recentTrades ?? []} />
          <MarketPanel signals={market?.signals ?? []} mlAuc={market?.mlAuc ?? null} performance={perf} />
        </div>

        <TickInspector />

        {/* ── Realized teljesítmény-analitika + előre menő árnyék-mérés ── */}
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <AnalyticsPanel />
          <ShadowPanel />
        </div>

        {/* ── Backtest + admin ── */}
        <div className="grid gap-4 lg:grid-cols-2">
          <BacktestPanel />
          <AdminPanel />
        </div>

        {/* ══════════ 2. SÁV — RÉSZVÉNY (USD, napi) ══════════ */}
        <div className="pt-4">
          <LaneHeader
            tone="info"
            label="Részvény"
            sub="AAPL · MSFT · NVDA · SPY · USD · napi (zárás után)"
            status={stockReady ? "paper" : "készenlét"}
          />
        </div>

        {/* Részvény KPI — SAJÁT pénztárca (USD, stock-paper scope) */}
        <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
          <Gauge label="Equity (USD)" value={stockReady ? fmtUsd(stockEquity) : "—"} />
          <Gauge label="Készpénz (USD)" value={stockReady ? fmtUsd(stockCash) : "—"} />
          <Gauge label="Pozíciók" value={stockReady ? String(stockPositions.length) : "—"} />
          <Gauge label="Elszámoló" value={stock?.quote ?? "USD"} />
        </section>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <PortfolioPanel cashUsd={stockCash} positions={stockPositions} hasDb={stockReady} />
          </div>
          <div className="lg:col-span-2 rounded-xl border border-line bg-panel p-5 font-mono text-[12px] leading-relaxed text-dim">
            <div className="mb-2 font-display text-[11px] font-medium uppercase tracking-[0.2em] text-info">
              Részvény-motor állapota
            </div>
            {stockReady ? (
              <p>
                A részvény paper-pénztárca aktív, saját USD-elszámolással. A napi profit-ciklus
                (stop / take-profit / trailing) az ülés zárása után fut.
              </p>
            ) : (
              <p>
                A részvény-motor kész (napi profit-ciklus, USD-pénztárca, a közös kockázati kapun),
                de a <span className="text-ink">napi ütemező</span> még nincs élesítve — ezért ez a
                sáv <span className="text-ink">készenléti</span> állapotban van, még nincs
                inicializált pénztárca. Bekapcsolás után itt jelennek meg a részvény-pozíciók és a
                saját egyenleg.
              </p>
            )}
          </div>
        </div>

        <footer className="pt-4 text-center font-mono text-[11px] text-faint">
          <span className="text-accent">KRIPTÓ</span> BTC · ETH · SOL (USDT) &nbsp;·&nbsp;{" "}
          <span className="text-info">RÉSZVÉNY</span> AAPL · MSFT · NVDA · SPY (USD) &nbsp;·&nbsp;
          külön pénztárcák &nbsp;·&nbsp; konzervatív limitek
        </footer>
      </main>
    </div>
  );
}

/** Egy sáv (eszközosztály) fejléce — vizuálisan elválasztja a kriptó és a részvény szekciót. */
function LaneHeader({
  tone,
  label,
  sub,
  status,
}: {
  tone: "accent" | "info";
  label: string;
  sub: string;
  status: string;
}) {
  const accent = tone === "accent";
  const dot = accent ? "bg-accent" : "bg-info";
  const text = accent ? "text-accentBright" : "text-info";
  const ring = accent ? "border-accent/30 bg-accent/10" : "border-info/30 bg-info/10";
  return (
    <div className={`flex items-center gap-3 rounded-xl border ${ring} px-4 py-2.5`}>
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden />
      <span className={`font-display text-sm font-bold tracking-[0.16em] ${text}`}>
        {label.toUpperCase()}
      </span>
      <span className="hidden font-mono text-[11px] text-faint sm:inline">{sub}</span>
      <span className={`ml-auto rounded border ${ring} px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${text}`}>
        {status}
      </span>
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
    <div className="bg-panel px-4 py-3.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-faint">{label}</div>
      <div className={`mt-1 font-mono text-xl tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-faint">{sub}</div>}
    </div>
  );
}

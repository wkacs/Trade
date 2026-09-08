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
import { NextCycle, StockSessionChip, StockSessionLine } from "./NextCycle";

interface StockFillApi {
  symbol: string;
  side: string;
  qty: number;
  amountUsd: number;
  price: number;
  origin: string | null;
  executedAt: string;
}

interface StockLaneApi {
  initialized: boolean;
  cashUsd: number;
  quote: string;
  positions: { symbol: string; qty: number; entryPrice: number; stopPrice?: number }[];
  recentFills?: StockFillApi[];
  /** A ténylegesen futó belépő-alak neve (built-in = a beépített kitörés-jel). */
  entryShape?: string;
  /** Igaz, ha van AKTÍV részvény-instrumentum (MARKETS_ENABLE_STOCKS). */
  enabled?: boolean;
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
  // A pénztárca megléte NEM jelenti, hogy a sáv fegyverben van: a flag közben lekapcsolhat,
  // és akkor a ciklus némán kihagyja magát. Ezt külön kell látni.
  const stockEnabled = stock?.enabled !== false;
  const stockFills = stock?.recentFills ?? [];

  return (
    <div className="min-h-screen">
      {/* ── Parancssáv: mi fut, milyen módban, milyen frissen ── */}
      <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-3 px-5 py-3">
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
            <span className="text-line" aria-hidden>
              /
            </span>
            <span>
              ML·AUC <span className="text-dim">{market?.mlAuc?.toFixed(3) ?? "—"}</span>
            </span>
            <span className="text-line" aria-hidden>
              /
            </span>
            <span>
              GLM <span className="text-dim">glm-4.7-flash</span>
            </span>
            <span className="text-line" aria-hidden>
              /
            </span>
            <span className="text-dim">{loading ? "betöltés…" : "élő · 60 mp"}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1680px] space-y-5 px-5 py-6">
        {/* Piaci pulzus — az egyetlen élő ár-feed, ezért a két sáv FÖLÖTT áll. */}
        {prices && <TickerStrip prices={prices} />}

        {/*
          A két eszközosztály KÜLÖN pénztárcát vezet, ezért a felületen is külön oszlop:
          bal a részvény, jobb a kriptó. A két oszlop szerkezete SZÁNDÉKOSAN azonos
          (állapot → számok → pozíciók → mi történt), így egy pillantással összevethető,
          és a szem nem tanul meg két külön elrendezést.
        */}
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <section className="lane-stock min-w-0 space-y-4" aria-labelledby="lane-stock">
            <LaneHeader
              id="lane-stock"
              tone="info"
              label="Részvény"
              sub="AAPL · MSFT · NVDA · SPY · USD"
              status={!stockEnabled ? "kikapcsolva" : stockReady ? "paper" : "készenlét"}
              right={
                <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                  <StockSessionChip />
                  <NextCycle lane="stock" />
                </span>
              }
            />
            <KpiRow>
              <Gauge label="Equity (USD)" value={stockReady ? fmtUsd(stockEquity) : "—"} />
              <Gauge label="Készpénz" value={stockReady ? fmtUsd(stockCash) : "—"} />
              <Gauge label="Pozíciók" value={stockReady ? String(stockPositions.length) : "—"} />
              <Gauge label="Kötések" value={stockReady ? String(stockFills.length) : "—"} />
            </KpiRow>
            <PortfolioPanel cashUsd={stockCash} positions={stockPositions} hasDb={stockReady} />
            <StockEnginePanel
              ready={stockReady}
              enabled={stockEnabled}
              fills={stockFills}
              entryShape={stock?.entryShape}
            />
          </section>

          <section className="lane-crypto min-w-0 space-y-4" aria-labelledby="lane-crypto">
            <LaneHeader
              id="lane-crypto"
              tone="accent"
              label="Kriptó"
              sub="BTC · ETH · SOL · USDT"
              status={hasDb ? "paper" : "offline"}
              right={<NextCycle lane="crypto" />}
            />
            <KpiRow>
              <Gauge label="Equity (USDT)" value={hasDb ? fmtUsd(equity) : "—"} accent />
              <Gauge
                label="P&L (kezdő óta)"
                value={hasDb ? `${pnlPct >= 0 ? "+" : "−"}${Math.abs(pnlPct).toFixed(2)}%` : "—"}
                tone={pnlPct >= 0 ? "up" : "down"}
                muted={!hasDb || Math.abs(pnlPct) < 0.005}
              />
              <Gauge label="Készpénz" value={hasDb ? fmtUsd(cashUsd) : "—"} />
              <Gauge label="Pozíciók" value={hasDb ? String(positions.length) : "—"} />
            </KpiRow>
            <PortfolioPanel cashUsd={cashUsd} positions={positions} hasDb={hasDb} prices={prices} />
            <TradeBlotter trades={data?.recentTrades ?? []} />
            <RiskPanel
              config={market?.config ?? null}
              weeklyBudgetRemainingUsd={market?.weeklyBudgetRemainingUsd ?? null}
            />
            <StrategyPanel config={market?.config ?? null} />
          </section>
        </div>

        {/* A döntés-napló a teljes szélességet kéri: itt az ÉRVELÉS a tartalom, nem a szám.
            A kriptó sáv gondolkodása, ezért annak a zöld árnyalatát viseli. */}
        <div className="lane-crypto">
          <DecisionsTimeline />
        </div>

        {/* Jel-minőség és realizált teljesítmény — a döntések MÖGÖTTI mérés. */}
        <MarketPanel signals={market?.signals ?? []} mlAuc={market?.mlAuc ?? null} performance={perf} />

        {/*
          Műhely: backteszt, analitika, árnyék-variánsok, tick-vizsgáló, admin. A napi út az
          OLVASÁS, ezért ezek nem tolakodhatnak a sávok elé — de egy kattintásra ott vannak.
        */}
        <details className="pt-1">
          <summary className="flex cursor-pointer list-none items-center gap-3 border-t border-line py-3 font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
            <svg
              className="chevron h-3 w-3 shrink-0 text-faint transition-transform duration-200"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden
            >
              <path d="M4.5 2.5 8 6l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Műhely — backteszt, analitika, árnyék-variánsok, admin
          </summary>
          <div className="space-y-4 pt-4">
            <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
              <AnalyticsPanel />
              <ShadowPanel />
            </div>
            <TickInspector />
            <div className="grid gap-4 lg:grid-cols-2">
              <BacktestPanel />
              <AdminPanel />
            </div>
          </div>
        </details>

        <footer className="border-t border-line pt-4 text-center font-mono text-[11px] text-faint">
          <span className="text-info">RÉSZVÉNY</span> AAPL · MSFT · NVDA · SPY (USD, day trading)
          &nbsp;·&nbsp; <span className="text-accent">KRIPTÓ</span> BTC · ETH · SOL (USDT)
          &nbsp;·&nbsp; külön pénztárcák &nbsp;·&nbsp; papír-mód, valódi pénz nincs a rendszerben
        </footer>
      </main>
    </div>
  );
}

/** A KPI-sor: hajszálvonallal elválasztott mérőórák, egyetlen keretben. */
function KpiRow({ children }: { children: React.ReactNode }) {
  return (
    <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
      {children}
    </section>
  );
}

/**
 * A részvény-motor állapota: ha fut, a mai kötések; ha nem, az ŐSZINTE ok. Készenléti
 * állapotban sem üres a panel — a napi olvasásnak azt is meg kell tudnia, MIÉRT csendes.
 */
function StockEnginePanel({
  ready,
  enabled,
  fills,
  entryShape,
}: {
  ready: boolean;
  enabled: boolean;
  fills: StockFillApi[];
  entryShape?: string;
}) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h3 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-info">
        Motor-állapot
      </h3>
      <div className="mt-3 font-mono text-[12px] leading-relaxed text-dim">
        <StockSessionLine />
        {!enabled && (
          <p className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[12px] text-ink">
            A sáv KI van kapcsolva: nincs aktív részvény-instrumentum
            (<span className="text-dim">MARKETS_ENABLE_STOCKS</span>). A ciklus lefut, de nem
            értékel ki papírt — a lenti egyenleg a korábbi állapot, nem élő kereskedés.
          </p>
        )}
        {fills.length > 0 && <StockFillList fills={fills} />}
        {ready ? (
          <>
            <p>
              A részvény paper-pénztárca aktív, saját USD-elszámolással.{" "}
              <span className="text-ink">Day trading</span>: az amerikai ülés alatt 5 percenként
              dönt 5 perces gyertyán, az utolsó fél órában már nem nyit újat, az utolsó 10 percben
              pedig mindent laposra zár — nincs overnight pozíció.
            </p>
            <p className="mt-2">
              Futó belépő-alak: <span className="text-ink">{entryShape ?? "built-in"}</span>
              {entryShape === "tod60+regime" &&
                " — belépő csak az ülés első 60 percében, és csak ha az SPY a saját trendje fölött van."}
              {(entryShape ?? "built-in") === "built-in" &&
                " — a beépített kitörés-jel dönt, napszak-szűrő nélkül."}
            </p>
          </>
        ) : (
          <p>
            A day-trading motor kész (5 perces ciklus, USD-pénztárca, közös kockázati kapu), de az{" "}
            <span className="text-ink">ütemező még nincs élesítve</span> — ezért ez a sáv készenléti
            állapotban áll, és nincs inicializált pénztárca. Bekapcsolás után itt jelennek meg a
            pozíciók, a kötések és az egyenleg.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * A részvény-sáv legutóbbi kötései. Day tradingben ez a nap története: mikor, mire, és
 * MIÉRT (momentum-belépő, stop, take-profit vagy nap végi laposra zárás).
 */
function StockFillList({ fills }: { fills: StockFillApi[] }) {
  const originLabel: Record<string, string> = {
    momentum: "kitörés",
    dca: "DCA",
    "stop-loss": "stop",
    "take-profit": "take-profit",
    "eod-flat": "nap végi zárás",
  };
  return (
    <div className="mb-4 overflow-x-auto">
      <table className="w-full min-w-[460px] text-left font-mono text-[11px]">
        <thead className="text-faint">
          <tr>
            <th className="pb-1 font-normal">idő (UTC)</th>
            <th className="pb-1 pl-3 font-normal">papír</th>
            <th className="pb-1 font-normal">irány</th>
            <th className="pb-1 pl-3 text-right font-normal">db</th>
            <th className="pb-1 pl-3 text-right font-normal">ár</th>
            <th className="pb-1 pr-3 text-right font-normal">érték</th>
            <th className="pb-1 font-normal">miért</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((f, i) => (
            <tr key={`${f.executedAt}-${f.symbol}-${i}`} className="border-t border-line/60">
              <td className="py-1 text-dim">{f.executedAt.slice(5, 16).replace("T", " ")}</td>
              <td className="py-1 pl-3 text-ink">{f.symbol}</td>
              <td className={`py-1 ${f.side === "BUY" ? "text-info" : "text-accent"}`}>{f.side}</td>
              <td className="py-1 pl-3 text-right text-dim">{f.qty}</td>
              <td className="py-1 pl-3 text-right text-dim">{f.price.toFixed(2)}</td>
              <td className="py-1 pr-3 text-right text-dim">{f.amountUsd.toFixed(2)}</td>
              <td className="py-1 text-faint">{f.origin ? (originLabel[f.origin] ?? f.origin) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Egy sáv (eszközosztály) fejléce — vizuálisan elválasztja a kriptó és a részvény szekciót. */
function LaneHeader({
  id,
  tone,
  label,
  sub,
  status,
  right,
}: {
  id: string;
  tone: "accent" | "info";
  label: string;
  sub: string;
  status: string;
  /** Jobb oldali kiegészítő — a ciklus-visszaszámláló ül itt. */
  right?: React.ReactNode;
}) {
  const accent = tone === "accent";
  const dot = accent ? "bg-accent" : "bg-info";
  const text = accent ? "text-accentBright" : "text-info";
  const ring = accent ? "border-accent/30 bg-accent/10" : "border-info/30 bg-info/10";
  return (
    <div className={`flex items-center gap-3 rounded-xl border ${ring} px-4 py-2.5`}>
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden />
      <h2 id={id} className={`font-display text-sm font-bold tracking-[0.16em] ${text}`}>
        {label.toUpperCase()}
      </h2>
      <span className="hidden font-mono text-[11px] text-faint sm:inline">{sub}</span>
      <span className="ml-auto flex items-center gap-3">
        {right}
        <span className={`rounded border ${ring} px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${text}`}>
          {status}
        </span>
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

"use client";

import { useEffect, useState } from "react";

interface ClosedTradeRow {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  qtyClosed: number;
  pnlUsd: number;
  pnlPct: number;
  holdHours: number;
  exitOrigin: string;
  exitTs: number;
}
interface Breakdown {
  key: string;
  trades: number;
  winRate: number;
  avgPnlPct: number;
}
interface NetPerformance {
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalFeesUsd: number;
  realizations: number;
  legacyExcluded: number;
  problems: number;
}
interface DirectionStats {
  scored: number;
  hitRate: number | null;
  avgScorePct: number;
  unscored: Record<string, number>;
}
interface Data {
  closedTrades: ClosedTradeRow[];
  breakdowns: { byCoin: Breakdown[]; byExitOrigin: Breakdown[] };
  equityCurve: { ts: number; equityUsd: number }[];
  /** Nettó eredmény a fill-ledgerből. null = nem mérhető (NEM nulla). */
  net?: NetPerformance | null;
  /** IRÁNYTALÁLAT-diagnosztika — külön a profittól. */
  direction?: DirectionStats | null;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const tone = (n: number) => (n > 0 ? "text-up" : n < 0 ? "text-down" : "text-dim");

function BreakdownRows({ rows }: { rows: Breakdown[] }) {
  if (rows.length === 0) return <p className="text-faint">—</p>;
  return (
    <div className="space-y-1">
      {rows.map((b) => (
        <div
          key={b.key}
          className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-3 border-b border-line/40 py-1 last:border-0"
        >
          <span className="text-dim">{b.key}</span>
          <span className="tabular-nums text-faint">{b.trades}t</span>
          <span className="tabular-nums text-dim">{pct(b.winRate)} win</span>
          <span className={`tabular-nums ${tone(b.avgPnlPct)}`}>{signed(b.avgPnlPct)}</span>
        </div>
      ))}
    </div>
  );
}

/** Realized (valódi lezárt) teljesítmény: ledger + coin/kilépés-ok bontás + realized equity. */
export function AnalyticsPanel() {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    fetch("/api/analytics", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ closedTrades: [], breakdowns: { byCoin: [], byExitOrigin: [] }, equityCurve: [] }));
  }, []);

  const closed = data?.closedTrades ?? [];
  const lastEq = data?.equityCurve.at(-1)?.equityUsd;
  const net = data?.net ?? null;
  const direction = data?.direction ?? null;
  /** Hiányzó adat = „n/a", sosem 0 — a nulla díj hamis biztonságérzetet adna. */
  const usd = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `$${n.toFixed(2)}`);

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
          Realized teljesítmény
        </h2>
        <span className="font-mono text-[11px] text-faint">
          {closed.length} lezárt{lastEq !== undefined ? ` · eq $${lastEq.toFixed(2)}` : ""}
        </span>
      </div>

      {/* T23: a NETTÓ eredmény és az IRÁNYTALÁLAT külön sor — a kettő nem ugyanaz. */}
      {data && (
        <div className="mt-3 grid gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-2">
          <div className="flex justify-between gap-2 border-b border-line/40 py-1">
            <span className="text-faint">Realizált (díjak után)</span>
            <span className={`tabular-nums ${net ? tone(net.realizedPnlUsd) : "text-faint"}`}>
              {usd(net?.realizedPnlUsd)}
            </span>
          </div>
          <div className="flex justify-between gap-2 border-b border-line/40 py-1">
            <span className="text-faint">Nem realizált</span>
            <span className={`tabular-nums ${net ? tone(net.unrealizedPnlUsd) : "text-faint"}`}>
              {usd(net?.unrealizedPnlUsd)}
            </span>
          </div>
          <div className="flex justify-between gap-2 border-b border-line/40 py-1">
            <span className="text-faint">Díjak összesen</span>
            <span className="tabular-nums text-dim">{usd(net?.totalFeesUsd)}</span>
          </div>
          <div className="flex justify-between gap-2 border-b border-line/40 py-1">
            <span className="text-faint">Iránytalálat (nem profit)</span>
            <span className="tabular-nums text-dim">
              {direction && direction.hitRate !== null
                ? `${pct(direction.hitRate)} · ${direction.scored} pontozott`
                : "n/a"}
            </span>
          </div>
          {net && net.legacyExcluded > 0 && (
            <p className="text-[10px] text-faint sm:col-span-2">
              {net.legacyExcluded} örökölt (legacy-unverified) sor KIMARAD a mutatókból — nem hiteles bizonyíték.
            </p>
          )}
          {net && net.problems > 0 && (
            <p className="text-[10px] text-down sm:col-span-2">
              {net.problems} sor nem volt könyvelhető — nézd meg a naplót.
            </p>
          )}
        </div>
      )}

      {!data ? (
        <p className="mt-3 font-mono text-[11px] text-faint">Betöltés…</p>
      ) : closed.length === 0 ? (
        <p className="mt-3 font-mono text-[11px] text-faint">Még nincs lezárt trade.</p>
      ) : (
        <div className="mt-3 grid gap-4 font-mono text-[11px] sm:grid-cols-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.15em] text-faint">Coinonként</div>
            <BreakdownRows rows={data.breakdowns.byCoin} />
            <div className="mb-1 mt-3 text-[10px] uppercase tracking-[0.15em] text-faint">Kilépés-ok</div>
            <BreakdownRows rows={data.breakdowns.byExitOrigin} />
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.15em] text-faint">Utolsó lezártak</div>
            <div className="space-y-1">
              {closed
                .slice(-8)
                .reverse()
                .map((t, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[2.5rem_1fr_auto_auto] items-baseline gap-x-2 border-b border-line/40 py-1 last:border-0"
                  >
                    <span className="text-dim">{t.symbol}</span>
                    <span className="text-faint">
                      {t.exitOrigin} · {t.holdHours.toFixed(0)}h
                    </span>
                    <span className={`tabular-nums ${tone(t.pnlUsd)}`}>${t.pnlUsd.toFixed(2)}</span>
                    <span className={`tabular-nums ${tone(t.pnlPct)}`}>{signed(t.pnlPct)}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

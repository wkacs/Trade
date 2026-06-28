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
interface Data {
  closedTrades: ClosedTradeRow[];
  breakdowns: { byCoin: Breakdown[]; byExitOrigin: Breakdown[] };
  equityCurve: { ts: number; equityUsd: number }[];
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

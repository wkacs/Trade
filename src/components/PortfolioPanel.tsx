"use client";

interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice?: number;
}

/**
 * Készpénz + nyitott pozíciók élő P&L-lel — a portfólió „műszer-olvasata".
 * Az élő árat a /api/market adja (prices); enélkül belépési áron mutat.
 */
export function PortfolioPanel({
  cashUsd,
  positions,
  hasDb,
  prices,
}: {
  cashUsd: number;
  positions: Position[];
  hasDb: boolean;
  prices?: Record<string, { usd: number }>;
}) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
          Portfólió
        </h2>
        <span className="font-mono text-[11px] text-faint">
          készpénz <span className="text-ink">{hasDb ? `$${cashUsd.toFixed(2)}` : "—"}</span>
        </span>
      </div>

      <div className="mt-4 space-y-1.5">
        {positions.map((p) => {
          const live = prices?.[p.symbol]?.usd;
          const pnlPct = live ? ((live - p.entryPrice) / p.entryPrice) * 100 : null;
          const toStop = live && p.stopPrice ? ((live - p.stopPrice) / live) * 100 : null;
          return (
            <div key={p.symbol} className="rounded-lg border border-line/60 bg-panel2 px-3 py-2">
              <div className="flex items-baseline justify-between">
                <span className="font-display text-sm font-medium text-ink">{p.symbol}</span>
                {pnlPct != null && (
                  <span className={`font-mono text-xs tabular-nums ${pnlPct >= 0 ? "text-up" : "text-down"}`}>
                    {pnlPct >= 0 ? "+" : ""}
                    {pnlPct.toFixed(2)}%
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] text-faint tabular-nums">
                <span>
                  {p.qty.toFixed(6)} <span className="text-faint/70">@</span>{" "}
                  <span className="text-dim">{p.entryPrice.toFixed(2)}</span>
                </span>
                {live && (
                  <span>
                    most <span className="text-dim">{live.toFixed(2)}</span>
                  </span>
                )}
                {p.stopPrice != null && (
                  <span>
                    stop <span className="text-dim">{p.stopPrice.toFixed(2)}</span>
                    {toStop != null && <span className="text-faint/70"> ({toStop.toFixed(1)}%)</span>}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {positions.length === 0 && (
          <p className="font-mono text-xs text-faint">
            {hasDb ? "Nincs nyitott pozíció — az AI vár." : "Nincs adatbázis-kapcsolat."}
          </p>
        )}
      </div>
    </section>
  );
}

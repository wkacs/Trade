"use client";

interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
}

/**
 * Készpénz + nyitott pozíciók — a portfólió „műszer-olvasata".
 * Lásd spec §3.5.
 */
export function PortfolioPanel({
  cashUsd,
  positions,
  hasDb,
}: {
  cashUsd: number;
  positions: Position[];
  hasDb: boolean;
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
        {positions.map((p) => (
          <div
            key={p.symbol}
            className="flex items-center justify-between rounded-lg border border-line/60 bg-panel2 px-3 py-2"
          >
            <span className="font-display text-sm font-medium text-ink">{p.symbol}</span>
            <span className="font-mono text-xs text-dim tabular-nums">
              {p.qty.toFixed(6)} <span className="text-faint">@</span> ${p.entryPrice.toFixed(2)}
            </span>
          </div>
        ))}
        {positions.length === 0 && (
          <p className="font-mono text-xs text-faint">
            {hasDb ? "Nincs nyitott pozíció — az AI vár." : "Nincs adatbázis-kapcsolat."}
          </p>
        )}
      </div>
    </section>
  );
}

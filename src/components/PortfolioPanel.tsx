"use client";

interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  stopPrice?: number;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const signedUsd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;

/**
 * Készpénz + nyitott pozíciók — élő ár, ráköltött összeg (cost) és USD-ben kifejezett
 * P&L (nem csak %). Az élő árat a /api/market adja (prices); enélkül belépési áron mutat.
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
  // Portfólió-szintű összesítők.
  let totalCost = 0;
  let totalValue = 0;
  for (const p of positions) {
    const live = prices?.[p.symbol]?.usd;
    totalCost += p.qty * p.entryPrice;
    totalValue += (live ?? p.entryPrice) * p.qty;
  }
  const totalPnlUsd = totalValue - totalCost;

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
          Portfólió
        </h2>
        <span className="font-mono text-[11px] text-faint">
          készpénz <span className="text-ink">{hasDb ? usd(cashUsd) : "—"}</span>
        </span>
      </div>

      <div className="mt-4 space-y-1.5">
        {positions.map((p) => {
          const live = prices?.[p.symbol]?.usd;
          const cost = p.qty * p.entryPrice; // ráköltött (belépéskori) összeg
          const value = (live ?? p.entryPrice) * p.qty; // jelenlegi érték
          const pnlUsd = value - cost;
          const pnlPct = cost > 0 ? (pnlUsd / cost) * 100 : 0;
          const tone = pnlUsd >= 0 ? "text-up" : "text-down";
          return (
            <div key={p.symbol} className="rounded-lg border border-line/60 bg-panel2 px-3 py-2">
              <div className="flex items-baseline justify-between">
                <span className="font-display text-sm font-medium text-ink">{p.symbol}</span>
                {live != null && (
                  <span className={`font-mono text-sm tabular-nums ${tone}`}>
                    {signedUsd(pnlUsd)}{" "}
                    <span className="text-xs opacity-80">
                      ({pnlPct >= 0 ? "+" : ""}
                      {pnlPct.toFixed(2)}%)
                    </span>
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] text-faint tabular-nums">
                <span>
                  ráköltött <span className="text-dim">{usd(cost)}</span>
                </span>
                {live != null && (
                  <span>
                    most <span className="text-dim">{usd(value)}</span>
                  </span>
                )}
                <span>
                  {p.qty.toFixed(6)} <span className="text-faint/70">@</span>{" "}
                  <span className="text-dim">{p.entryPrice.toFixed(2)}</span>
                </span>
                {p.stopPrice != null && (
                  <span>
                    stop <span className="text-dim">{p.stopPrice.toFixed(2)}</span>
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

      {positions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 border-t border-line pt-2.5 font-mono text-[11px] tabular-nums">
          <span className="text-faint">
            ráköltött össz. <span className="text-dim">{usd(totalCost)}</span>
          </span>
          <span className="text-faint">
            most <span className="text-dim">{usd(totalValue)}</span>
          </span>
          <span className="text-faint">
            P&amp;L{" "}
            <span className={totalPnlUsd >= 0 ? "text-up" : "text-down"}>{signedUsd(totalPnlUsd)}</span>
          </span>
        </div>
      )}
    </section>
  );
}

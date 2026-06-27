"use client";

const SYMBOLS = ["BTC", "ETH", "SOL"];

/** Árfolyam-szalag: a kosár coinjai ár + 24h változás, terminál-stílusban. */
export function TickerStrip({
  prices,
}: {
  prices: Record<string, { usd: number; change24hPct: number }>;
}) {
  return (
    <div className="flex items-stretch gap-px overflow-x-auto rounded-xl border border-line bg-line">
      {SYMBOLS.map((s) => {
        const p = prices[s];
        const up = (p?.change24hPct ?? 0) >= 0;
        return (
          <div
            key={s}
            className="flex min-w-[150px] flex-1 items-baseline gap-2 bg-panel px-4 py-2.5 font-mono"
          >
            <span className="text-xs text-faint">{s}</span>
            <span className="tabular-nums text-ink">
              {p ? p.usd.toLocaleString("hu-HU", { maximumFractionDigits: p.usd > 100 ? 0 : 2 }) : "—"}
            </span>
            {p && (
              <span className={`text-xs tabular-nums ${up ? "text-up" : "text-down"}`}>
                {up ? "▴" : "▾"}
                {Math.abs(p.change24hPct).toFixed(1)}%
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

"use client";

export interface BlotterTrade {
  symbol: string;
  side: string;
  qty: number;
  price: number;
  amountUsd: number;
  feeUsd: number;
  executedAt: string;
  mode: string;
  origin?: string | null;
}

const ORIGIN: Record<string, { label: string; cls: string }> = {
  dca: { label: "DCA", cls: "text-accentBright" },
  "stop-loss": { label: "STOP", cls: "text-down" },
  "take-profit": { label: "TP", cls: "text-up" },
  ai: { label: "AI", cls: "text-dim" },
  manual: { label: "KÉZI", cls: "text-faint" },
};
function OriginBadge({ origin }: { origin?: string | null }) {
  const o = origin ? ORIGIN[origin] : null;
  return (
    <span className={`font-mono text-[9px] uppercase tracking-wider ${o?.cls ?? "text-faint"}`}>
      {o?.label ?? "—"}
    </span>
  );
}

/** Végrehajtott tranzakciók naplója (blotter). */
export function TradeBlotter({ trades }: { trades: BlotterTrade[] }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
          Trade-napló
        </h2>
        <span className="font-mono text-[11px] text-faint">{trades.length} tranzakció</span>
      </div>
      <div className="mt-3 space-y-1 font-mono text-[11px]">
        {trades.length === 0 && <p className="text-faint">Még nincs trade.</p>}
        {trades.map((t, i) => {
          const buy = t.side === "BUY";
          const time = new Date(t.executedAt).toLocaleString("hu-HU", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <div
              key={i}
              className="grid grid-cols-[auto_2.5rem_2.5rem_1fr_auto] items-baseline gap-x-2 border-b border-line/40 py-1 last:border-0"
            >
              <span className="text-faint">{time}</span>
              <span className={buy ? "text-up" : "text-down"}>{t.side}</span>
              <OriginBadge origin={t.origin} />
              <span className="truncate text-dim">
                {t.symbol} {t.qty.toFixed(6)} <span className="text-faint">@</span> {t.price.toFixed(2)}
              </span>
              <span className="tabular-nums text-ink">${t.amountUsd.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

"use client";

interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
}

interface PortfolioData {
  cashUsd: number;
  positions: Position[];
}

/**
 * Főpanel: jelenlegi egyenleg, P&L, aktív pozíciók kártyái.
 * Lásd spec §3.5.
 */
export function PortfolioPanel({ cashUsd, positions }: PortfolioData) {
  const positionsValue = positions.reduce((s, p) => s + p.qty * p.entryPrice, 0);
  const total = cashUsd + positionsValue;
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Portfólió</h2>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Stat label="Készpénz" value={`$${cashUsd.toFixed(2)}`} />
        <Stat label="Pozíciók" value={`$${positionsValue.toFixed(2)}`} />
        <Stat label="Összesen" value={`$${total.toFixed(2)}`} highlight />
      </div>
      <div className="mt-4 space-y-2">
        {positions.map((p) => (
          <div key={p.symbol} className="flex justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm">
            <span className="font-medium text-gray-900">{p.symbol}</span>
            <span className="text-gray-600">
              {p.qty.toFixed(6)} @ ${p.entryPrice.toFixed(2)}
            </span>
          </div>
        ))}
        {positions.length === 0 && (
          <p className="text-sm text-gray-400">Még nincsenek nyitott pozíciók.</p>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div
        className={`text-xl font-semibold ${highlight ? "text-blue-600" : "text-gray-900"}`}
      >
        {value}
      </div>
    </div>
  );
}

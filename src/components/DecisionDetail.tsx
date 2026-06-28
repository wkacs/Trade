import type { DecisionRow } from "./DecisionCard";

/**
 * A „miért döntött így?" kibontható részlet — a döntés metaadatai mono kulcs-érték
 * sorokban. (A bemeneti hír/whale pillanatkép egy későbbi bővítés.)
 */
export function DecisionDetail({ d }: { d: DecisionRow }) {
  const rows: [string, string][] = [
    ["modell", d.model ?? "—"],
    ["mennyiség", `${((d.amountPct ?? 0) * 100).toFixed(1)}% tőke`],
    ["bizonyosság", `${Math.round(d.confidence * 100)}%`],
  ];
  const refPrices = d.ref?.prices ?? null;
  return (
    <>
      <dl className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line">
        {rows.map(([k, v]) => (
          <div key={k} className="bg-panel px-3 py-2">
            <dt className="font-mono text-[10px] uppercase tracking-wider text-faint">{k}</dt>
            <dd className="mt-0.5 font-mono text-xs text-dim">{v}</dd>
          </div>
        ))}
      </dl>
      {refPrices && (
        <p className="mt-2 font-mono text-[10px] text-faint">
          döntéskori ár: {Object.entries(refPrices).map(([s, p]) => `${s} $${p.toFixed(0)}`).join(" · ")}
        </p>
      )}
    </>
  );
}

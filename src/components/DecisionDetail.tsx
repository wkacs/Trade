import type { DecisionRow } from "./DecisionCard";

/**
 * A „Miért döntött így?" kibontható részlet — metaadatok a döntésről.
 * NOTE: a bemeneti adatok (hírek, whale-mozgások) pillanatképe a raw_events
 * táblából tölthető egy későbbi feladatban; ez a vázlat a metaadatokat mutatja.
 */
export function DecisionDetail({ d }: { d: DecisionRow }) {
  return (
    <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
      <div className="mb-1">
        <b>Modell:</b> {d.model ?? "—"}
      </div>
      <div className="mb-1">
        <b>Mennyiség:</b> {((d.amountPct ?? 0) * 100).toFixed(1)}% tőke
      </div>
      <div>
        <b>Bizonyosság:</b> {Math.round(d.confidence * 100)}%
      </div>
    </div>
  );
}

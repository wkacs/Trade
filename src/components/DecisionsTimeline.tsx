"use client";

import { useEffect, useState } from "react";
import { DecisionCard, type DecisionRow } from "./DecisionCard";

/**
 * Döntések idővonala — a legfrissebb döntések felül, érvelésekkel.
 * Lásd spec §3.5. Az /api/decisions route-t hívja.
 */
export function DecisionsTimeline() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/decisions?limit=50")
      .then((r) => r.json())
      .then((d) => {
        setDecisions(d.decisions ?? []);
        setError(d.error ?? null);
      })
      .catch(() => setError("Nem sikerült betölteni a döntéseket."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Döntések idővonala</h2>
      <p className="mt-1 text-xs text-gray-500">
        Az AI „saját véleménye" — minden döntés mögött látható az érvelés.
      </p>
      {loading && <p className="mt-4 text-sm text-gray-400">Betöltés…</p>}
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      <div className="mt-4 space-y-3">
        {decisions.map((d) => (
          <DecisionCard key={d.id} d={d} />
        ))}
        {!loading && !error && decisions.length === 0 && (
          <p className="text-sm text-gray-400">
            Még nincsenek döntések. Várd meg a következő órát, vagy indítsd manuálisan a cron tick-et.
          </p>
        )}
      </div>
    </div>
  );
}

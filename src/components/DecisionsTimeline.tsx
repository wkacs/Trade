"use client";

import { useEffect, useState } from "react";
import { DecisionCard, type DecisionRow } from "./DecisionCard";

/**
 * A döntés-napló — a konzol főszereplője. Időrendi szál (a rendszer szívverése)
 * köti össze az óránkénti döntéseket, mindegyik a teljes érveléssel. Lásd spec §3.5.
 */
export function DecisionsTimeline() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/decisions?limit=50")
        .then((r) => r.json())
        .then((d) => {
          setDecisions(d.decisions ?? []);
          setError(d.error ?? null);
        })
        .catch(() => setError("A döntéseket nem sikerült betölteni. Frissíts később."))
        .finally(() => setLoading(false));
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const lastTick = decisions[0]?.ts ? new Date(decisions[0].ts) : null;

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-accent">
            Döntés-napló
          </h2>
          <p className="mt-1 font-sans text-xs text-dim">
            Az AI saját véleménye — minden döntés mögött a teljes érvelés.
          </p>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-faint">
          {lastTick ? `utolsó: ${lastTick.toLocaleString("hu-HU", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}
        </span>
      </div>

      {loading && <p className="mt-5 font-mono text-xs text-faint">napló betöltése…</p>}
      {error && <p className="mt-5 font-mono text-xs text-down">{error}</p>}

      {!loading && !error && (
        <div className="relative mt-5">
          {/* a szívverés-szál: frissen accent, lefelé (régebbi) elhalványul */}
          <div
            className="absolute bottom-2 left-2 top-2 w-px bg-gradient-to-b from-accent/50 via-line to-transparent"
            aria-hidden
          />
          <ol className="space-y-3">
            {decisions.map((d, i) => (
              <li key={d.id} className="relative pl-8">
                <span
                  className={
                    i === 0
                      ? "pulse-dot absolute left-2 top-4 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-accent"
                      : "absolute left-2 top-4 h-2 w-2 -translate-x-1/2 rounded-full bg-line ring-2 ring-bg"
                  }
                  aria-hidden
                />
                <DecisionCard d={d} latest={i === 0} />
              </li>
            ))}
            {decisions.length === 0 && (
              <li className="font-mono text-xs text-faint">
                Még üres a napló. Az első tick után itt jelenik meg az AI döntése — a ciklust
                az aktív ütemező indítja (worker, GitHub Actions vagy külső HTTP-cron), kézzel
                pedig a hitelesített POST /api/cron/tick hívás.
              </li>
            )}
          </ol>
        </div>
      )}
    </section>
  );
}

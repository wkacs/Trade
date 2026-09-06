"use client";

import { useEffect, useState } from "react";

export interface ShadowRow {
  accountId: string;
  cycles: number;
  days: number;
  equity: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  roundTrips: number;
  feesQuote: number;
  degradedCycles: number;
}

export interface ShadowLaneView {
  namespace: string;
  candidateId: string;
  note: string;
  capitalUsd: number;
  startedAt: string | null;
  targetDays: number | null;
  targetRoundTrips: number | null;
  rows: ShadowRow[];
  error: string | null;
}

const signed = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-dim");

/** Egy számla sora: az alapvonal és a jelölt UGYANAZOKAT az oszlopokat kapja. */
function AccountRow({ row, isBaseline }: { row: ShadowRow; isBaseline: boolean }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-3 border-b border-line/40 py-1 last:border-0">
      <span className={isBaseline ? "text-faint" : "text-ink"}>
        {isBaseline ? "alapvonal" : row.accountId}
      </span>
      <span className="tabular-nums text-dim">${row.equity.toFixed(2)}</span>
      <span className={`tabular-nums ${tone(row.netReturnPct)}`}>{signed(row.netReturnPct)}</span>
      <span className="tabular-nums text-faint">{row.roundTrips} kör</span>
    </div>
  );
}

/** Egy sáv sora. Exportált, mert tiszta bemenettel tesztelhető, hálózat nélkül. */
export function ShadowLaneRow({ lane }: { lane: ShadowLaneView }) {
  const baseline = lane.rows.find((r) => r.accountId === "baseline");
  const candidate = lane.rows.find((r) => r.accountId !== "baseline");
  const diff =
    baseline && candidate ? candidate.netReturnPct - baseline.netReturnPct : null;
  const cycles = candidate?.cycles ?? baseline?.cycles ?? 0;
  const days = candidate?.days ?? baseline?.days ?? 0;

  return (
    <div className="border-t border-line/40 pt-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-display text-xs text-ink">{lane.candidateId}</h3>
        <span className="font-mono text-[10px] text-faint">
          {cycles} ciklus · {days}/{lane.targetDays ?? "?"} nap
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-faint">{lane.note}</p>

      {lane.error ? (
        <p className="mt-2 font-mono text-[11px] text-amber-400/80">nem olvasható: {lane.error}</p>
      ) : lane.rows.length === 0 ? (
        <p className="mt-2 font-mono text-[11px] text-faint">még nincs ciklus</p>
      ) : (
        <div className="mt-2 font-mono text-[11px]">
          {baseline && <AccountRow row={baseline} isBaseline />}
          {candidate && <AccountRow row={candidate} isBaseline={false} />}
          <div className="flex items-baseline justify-between pt-1.5">
            <span className="text-faint">különbség</span>
            <span className={`tabular-nums ${diff === null ? "text-dim" : tone(diff)}`}>
              {diff === null ? "—" : signed(diff)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Előre menő paper-mérések: a futó stratégia és egy-egy kockázatosabb jelölt
 * EGYMÁS MELLETT, ugyanazon az adatfolyamon. A visszateszt a múltat méri; ez a jövőt.
 *
 * A „még nincs ciklus" és a nulla különbség ÉRVÉNYES állapot: ha a stratégiák nem
 * léptek be, azt látni kell, nem elrejteni.
 */
export function ShadowPanel() {
  const [lanes, setLanes] = useState<ShadowLaneView[] | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/shadow", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setLanes(d.lanes ?? []))
        .catch(() => setLanes([]));
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
          Árnyék-mérés — jelöltek papíron
        </h2>
        <span className="font-mono text-[11px] text-faint">
          {lanes === null ? "betöltés…" : `${lanes.length} sáv`}
        </span>
      </div>

      {lanes !== null && lanes.length === 0 && (
        <p className="mt-3 font-mono text-[11px] text-faint">Nincs futó árnyék-mérés.</p>
      )}

      <div className="mt-3 space-y-3">
        {lanes?.map((lane) => (
          <ShadowLaneRow key={lane.namespace} lane={lane} />
        ))}
      </div>
    </section>
  );
}

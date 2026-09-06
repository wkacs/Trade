"use client";

import { useState } from "react";
import { DecisionDetail } from "./DecisionDetail";

export interface DecisionRow {
  id: string;
  ts: string | Date;
  action: "BUY" | "SELL" | "HOLD";
  symbol: string | null;
  amountPct: number | null;
  confidence: number;
  reasoning: string;
  model?: string;
  overridden: boolean;
  overrideReason: string | null;
  /**
   * A `decisions.outcome` oszlop tükre. A mezőnevek a backend `DecisionOutcome`-jából
   * jönnek (src/lib/portfolio/evaluate.ts): irány-pontszám, NEM realizált profit.
   */
  outcome?: {
    horizonHours: number;
    refSymbol: string | null;
    changePct: number;
    directionalScorePct: number;
    directionHit: boolean | null;
    unscored?: "stale_horizon" | "missing_price" | "no_intent";
  } | null;
  ref?: { prices?: Record<string, number> } | null;
}

const STAMP: Record<string, string> = {
  BUY: "border-up/40 bg-up/10 text-up",
  SELL: "border-down/40 bg-down/10 text-down",
  HOLD: "border-line bg-panel2 text-dim",
};

/**
 * Egy napló-bejegyzés: action-stamp, symbol, bizonyosság-mérő, idő, az érvelés
 * (humanista sans — az AI „hangja"), és — ha már beérett — a „bejött volna?" verdikt.
 */
export function DecisionCard({ d, latest }: { d: DecisionRow; latest?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <article
      className={`fade-up rounded-xl border bg-panel2 p-4 ${latest ? "border-accent/25" : "border-line"}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className={`rounded border px-2 py-0.5 font-mono text-[11px] font-medium tracking-wide ${STAMP[d.action]}`}
          >
            {d.action}
          </span>
          {d.symbol && <span className="font-display text-sm text-ink">{d.symbol}</span>}
          <Confidence v={d.confidence} />
          {d.overridden && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-amber-400/80">
              risk-módosítva
            </span>
          )}
        </div>
        <time className="shrink-0 font-mono text-[11px] text-faint">
          {new Date(d.ts).toLocaleString("hu-HU", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>

      <p className="mt-2.5 font-sans text-[13.5px] leading-relaxed text-ink/90">{d.reasoning}</p>

      {d.overridden && d.overrideReason && (
        <p className="mt-1.5 font-mono text-[11px] text-amber-400/70">↳ {d.overrideReason}</p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <Outcome outcome={d.outcome} />
        <button
          onClick={() => setOpen(!open)}
          className="shrink-0 font-mono text-[11px] text-accent/80 transition-colors hover:text-accentBright"
        >
          {open ? "← kevesebb" : "miért döntött így?"}
        </button>
      </div>

      {open && <DecisionDetail d={d} />}
    </article>
  );
}

function Confidence({ v }: { v: number }) {
  const pct = Math.round(v * 100);
  return (
    <span className="flex items-center gap-1.5" title={`bizonyosság ${pct}%`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-line">
        <span className="block h-full rounded-full bg-accent/70" style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-[11px] tabular-nums text-faint">{(v).toFixed(2)}</span>
    </span>
  );
}

const UNSCORED_LABEL: Record<string, string> = {
  stale_horizon: "elavult horizont",
  missing_price: "hiányzó ár",
  no_intent: "nincs szándék",
};

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/**
 * A döntés utólagos IRÁNY-verdiktje. Defenzív: a T20 előtti sorokon a mai mezők
 * hiányoznak, és egy `undefined.toFixed()` az egész dashboardot ledöntené.
 */
function Outcome({ outcome }: { outcome: DecisionRow["outcome"] }) {
  if (!outcome) {
    return (
      <span className="font-mono text-[11px] text-faint">kiértékelés ~1h múlva…</span>
    );
  }
  const { directionHit, directionalScorePct, changePct, refSymbol, horizonHours, unscored } =
    outcome;

  if (unscored) {
    return (
      <span className="font-mono text-[11px] text-faint">
        nem pontozható — {UNSCORED_LABEL[unscored] ?? unscored}
      </span>
    );
  }

  const score = Number.isFinite(directionalScorePct) ? directionalScorePct : null;
  const change = Number.isFinite(changePct) ? changePct : null;

  // HOLD (directionHit === null) vagy hiányzó pontszám → semleges sor, számok nélkül.
  if (directionHit == null || score == null) {
    return (
      <span className="font-mono text-[11px] text-dim">
        {horizonHours}h: piac {change == null ? "—" : pct(change)} — semleges
      </span>
    );
  }

  return (
    <span
      className={`flex items-center gap-1.5 font-mono text-[11px] ${directionHit ? "text-up" : "text-down"}`}
    >
      <span>{directionHit ? "✓ eltalálta az irányt" : "✗ nem találta el"}</span>
      <span className="text-faint">·</span>
      <span className="tabular-nums">
        {refSymbol} {pct(score)} ({horizonHours}h)
      </span>
    </span>
  );
}

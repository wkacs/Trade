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
}

const ACTION_STYLE: Record<string, string> = {
  BUY: "bg-green-100 text-green-700",
  SELL: "bg-red-100 text-red-700",
  HOLD: "bg-gray-100 text-gray-600",
};

/**
 * Egy döntés kártyája: action badge, symbol, confidence, idő,
 * és — a projekt szíve — a teljes érvelés szövege.
 * Kibontható „Miért döntött így?" részlettel. Lásd spec §3.5.
 */
export function DecisionCard({ d }: { d: DecisionRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-bold ${ACTION_STYLE[d.action]}`}
          >
            {d.action}
          </span>
          {d.symbol && <span className="font-medium text-gray-900">{d.symbol}</span>}
          {d.overridden && (
            <span className="text-xs text-amber-600">⚠ Risk Manager módosította</span>
          )}
        </div>
        <div className="text-xs text-gray-500">
          {new Date(d.ts).toLocaleString("hu-HU")} · {Math.round(d.confidence * 100)}%
        </div>
      </div>
      <p className="mt-2 text-sm text-gray-700">{d.reasoning}</p>
      {d.overridden && d.overrideReason && (
        <p className="mt-1 text-xs text-amber-700">→ {d.overrideReason}</p>
      )}
      <button
        onClick={() => setOpen(!open)}
        className="mt-2 text-xs text-blue-600 hover:underline"
      >
        {open ? "Kevesebb" : "Miért döntött így?"}
      </button>
      {open && <DecisionDetail d={d} />}
    </div>
  );
}

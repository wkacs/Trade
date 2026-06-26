"use client";

import { useEffect, useState } from "react";

/**
 * Kereskedési mód kapcsoló (paper ↔ live). A live módhoz explicit megerősítés kell.
 * Lásd spec §3.5 + §6.
 */
export function AdminPanel() {
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [currentMode, setCurrentMode] = useState<string>("?");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin")
      .then((r) => r.json())
      .then((d) => {
        setCurrentMode(d.mode ?? "paper");
        setMode((d.mode as "paper" | "live") ?? "paper");
      })
      .catch(() => {});
  }, []);

  const switchMode = async () => {
    setMessage(null);
    const r = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, confirm }),
    });
    const d = await r.json();
    setMessage(r.ok ? `✓ ${d.note}` : `✗ ${d.error}`);
    if (r.ok) setCurrentMode(mode);
  };

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-dim">
          Kereskedési mód
        </h2>
        <span className="font-mono text-[11px] text-faint">
          jelenleg <span className={currentMode === "live" ? "text-down" : "text-up"}>{currentMode}</span>
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        {(["paper", "live"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded-lg border px-3 py-2 font-mono text-xs transition-colors ${
              mode === m
                ? m === "live"
                  ? "border-down/50 bg-down/10 text-down"
                  : "border-iris/40 bg-iris/10 text-irisBright"
                : "border-line bg-panel2 text-faint hover:text-dim"
            }`}
          >
            {m === "paper" ? "paper (demo)" : "live (valós pénz)"}
          </button>
        ))}
      </div>

      {mode === "live" && (
        <div className="mt-3 rounded-lg border border-down/30 bg-down/5 p-3">
          <p className="font-sans text-xs text-down/90">
            Valós pénzzel kereskednél. A megerősítéshez írd be:{" "}
            <code className="rounded bg-bg px-1 font-mono text-down">I-UNDERSTAND-THE-RISK</code>
          </p>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-2 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-faint focus:border-iris/50"
            placeholder="I-UNDERSTAND-THE-RISK"
          />
        </div>
      )}

      <button
        onClick={switchMode}
        className="mt-3 rounded-lg border border-line bg-panel2 px-3.5 py-1.5 font-mono text-xs text-ink transition-colors hover:border-dim"
      >
        mentés
      </button>
      {message && <p className="mt-3 font-mono text-[11px] text-dim">{message}</p>}
    </section>
  );
}

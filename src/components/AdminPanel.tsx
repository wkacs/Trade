"use client";

import { useEffect, useState } from "react";

/**
 * Admin panel — trading mode kapcsoló (paper ↔ live).
 * BIZTONSÁG: a live módhoz explicit megerősítés kell.
 * Lásd spec §3.5 + §6. Az /api/admin route-t hívja.
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
    if (!r.ok) {
      setMessage(`❌ ${d.error}`);
    } else {
      setMessage(`✅ ${d.note}`);
      setCurrentMode(mode);
    }
  };

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Admin — Trading Mode</h2>
      <p className="mt-1 text-xs text-gray-500">
        Jelenlegi mód: <span className="font-medium">{currentMode}</span>
      </p>
      <div className="mt-3 flex gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={mode === "paper"}
            onChange={() => setMode("paper")}
          />{" "}
          Paper (demo)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={mode === "live"}
            onChange={() => setMode("live")}
          />{" "}
          Live (valós pénz)
        </label>
      </div>
      {mode === "live" && (
        <div className="mt-3 rounded-lg bg-red-50 p-3">
          <p className="text-xs text-red-700">
            ⚠ Figyelem: valós pénzzel kereskednél! A módosításhoz írd be:{" "}
            <code className="rounded bg-white px-1">I-UNDERSTAND-THE-RISK</code>
          </p>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-2 w-full rounded border px-2 py-1 text-sm"
            placeholder="I-UNDERSTAND-THE-RISK"
          />
        </div>
      )}
      <button
        onClick={switchMode}
        className="mt-3 rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900"
      >
        Mentés
      </button>
      {message && <p className="mt-3 text-xs text-gray-600">{message}</p>}
    </div>
  );
}

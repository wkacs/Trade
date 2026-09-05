"use client";

import { useEffect, useState } from "react";
import { explainNoTrade, type TickProcess } from "@/lib/engine/tick-process";

interface TickRow {
  id: string;
  ts: string;
  tickId: string;
  process: TickProcess;
}

/** A kiválasztott tick TELJES lánca: inputok → ML → profit-ciklus → phase1 → phase2 → risk → végrehajtás. */
export function TickInspector() {
  const [ticks, setTicks] = useState<TickRow[]>([]);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const load = () =>
      fetch("/api/ticks?limit=20", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setTicks(d.ticks ?? []))
        .catch(() => setTicks([]));
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const t = ticks[sel]?.process;

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-accent">
          Tick-inspector — a teljes lánc
        </h2>
        {ticks.length > 0 && (
          <select
            className="rounded border border-line bg-panel2 px-2 py-1 font-mono text-[11px] text-dim"
            value={sel}
            onChange={(e) => setSel(Number(e.target.value))}
          >
            {ticks.map((r, i) => (
              <option key={r.id} value={i}>{r.tickId}</option>
            ))}
          </select>
        )}
      </div>

      {!t && <p className="mt-5 font-mono text-xs text-faint">Még nincs naplózott tick. Az első tick (a napló élesítése) után jelenik meg.</p>}

      {t && (
        <ol className="mt-4 space-y-2">
          <Step n="1" title="Inputok" fired>
            {Object.entries(t.inputs.prices).map(([s, p]) => `${s} $${p.toFixed(0)}`).join(" · ")}
            {t.inputs.fearGreed ? ` · F&G ${t.inputs.fearGreed.value} (${t.inputs.fearGreed.classification})` : ""}
          </Step>
          <Step n="2" title="ML-jel" fired={t.inputs.mlSignals.length > 0}>
            {t.inputs.mlSignals.map((s) => `${s.symbol} ${s.direction1h} ${(s.confidence * 100).toFixed(0)}%`).join(" · ") || "nincs jel"}
          </Step>
          <Step n="3" title="Profit-ciklus" fired={t.cycleActions.length > 0}>
            {t.cycleActions.map((a) => `${a.kind.toUpperCase()} ${a.side} ${a.symbol}${a.amountUsd ? ` $${a.amountUsd.toFixed(0)}` : ""}`).join(" · ") || "nincs akció (stop/TP/DCA nem tüzelt)"}
          </Step>
          <Step n="4" title="Phase-1 (AI szűrő)" fired={t.phase1.shouldDecide}>
            {t.phase1.shouldDecide ? "döntésre érdemes" : "kihagyva"} — {t.phase1.summary}
          </Step>
          <Step n="5" title="Phase-2 (AI döntés)" fired={!!t.phase2}>
            {t.phase2 ? `${t.phase2.action} ${t.phase2.symbol ?? ""} (${(t.phase2.confidence * 100).toFixed(0)}%) — ${t.phase2.reasoning}` : "nem hívva (phase-1 nemet mondott)"}
          </Step>
          <Step n="6" title="Risk Manager" fired={t.decision.overridden}>
            {t.decision.overridden ? `módosítva → ${t.decision.action} (${t.decision.overrideReason ?? "—"})` : "változatlanul átengedve"}
          </Step>
          <Step n="7" title="Végrehajtás" fired={t.trades.length > 0}>
            {t.trades.map((tr) => `${tr.origin.toUpperCase()} ${tr.side} ${tr.symbol} $${tr.amountUsd.toFixed(0)}`).join(" · ") || "nincs trade"}
          </Step>
        </ol>
      )}

      {/* T23: futási állapot és adatminőség. A hiányzó adat „n/a”, sosem 0. */}
      {t?.health && <HealthBlock health={t.health} process={t} />}
    </section>
  );
}

function Step({ n, title, fired, children }: { n: string; title: string; fired?: boolean; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_8rem_1fr] items-start gap-2 border-b border-line/40 pb-2 last:border-0">
      <span className={`font-mono text-[11px] ${fired ? "text-accentBright" : "text-faint"}`}>{n}</span>
      <span className={`font-mono text-[11px] uppercase tracking-wider ${fired ? "text-dim" : "text-faint"}`}>{title}</span>
      <span className={`font-sans text-[12px] ${fired ? "text-ink/90" : "text-faint"}`}>{children}</span>
    </li>
  );
}

/**
 * Futási állapot és adatminőség (T23). A meglévő dashboard stílusához illeszkedik —
 * nincs új vizuális irány, csak egy tömör, monospace állapot-sor.
 *
 * Alapszabály: a hiányzó adat „n/a”, SOSEM 0. Egy 0 ms-os quote-kor vagy 0 USD díj
 * hamis biztonságérzetet adna.
 */
function HealthBlock({ health, process: p }: { health: NonNullable<TickProcess["health"]>; process: TickProcess }) {
  const reasons = explainNoTrade(p);
  const ms = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${n} ms`);
  const failedSources = health.collectors.filter((c) => !c.ok).map((c) => c.name);
  const thinData = Object.entries(health.signals).filter(([, s]) => !s.sufficient);

  return (
    <div className="mt-4 border-t border-line/40 pt-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.15em] text-faint">Futási állapot</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-3">
        <Health label="Kereskedés" value={health.tradingEnabled ? "engedélyezve" : "tiltva"} warn={!health.tradingEnabled} />
        <Health label="Quote-kor" value={ms(health.quoteAgeMs)} warn={health.quotesDegraded} />
        <Health
          label="Napi kapu"
          value={
            health.dayGate.dayPnlPct === null
              ? `${health.dayGate.source} · n/a`
              : `${(health.dayGate.dayPnlPct * 100).toFixed(2)}%${health.dayGate.latched ? " · latch" : ""}`
          }
          warn={health.dayGate.blockNewBuys}
        />
        <Health
          label="ML-modell"
          value={health.ml.usable ? `${health.ml.signalCount} jel` : "karantén"}
          warn={!health.ml.usable}
        />
        <Health label="Adatforrás" value={failedSources.length === 0 ? "rendben" : failedSources.join(", ")} warn={failedSources.length > 0} />
        <Health
          label="LLM"
          value={health.llm ? `${health.llm.totalTokens ?? "n/a"} token · ${health.llm.latencyMs} ms` : "nem hívva"}
          warn={health.llm?.failed === true}
        />
        <Health
          label="Előzmény"
          value={thinData.length === 0 ? "elegendő" : thinData.map(([s, v]) => `${s} ${v.bars}/${v.requiredBars}`).join(", ")}
          warn={thinData.length > 0}
        />
        <Health
          label="Szakasz-idők"
          value={Object.entries(health.stageMs).map(([k, v]) => `${k} ${v}ms`).join(" · ") || "n/a"}
        />
        <Health label="Kihagyott order" value={health.staleSkips.length === 0 ? "nincs" : String(health.staleSkips.length)} warn={health.staleSkips.length > 0} />
      </dl>

      {reasons.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.15em] text-faint">Miért nem történt kötés</div>
          <ul className="space-y-0.5 font-sans text-[12px] text-dim">
            {reasons.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Health({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/30 py-0.5">
      <dt className="text-faint">{label}</dt>
      <dd className={`truncate tabular-nums ${warn ? "text-down" : "text-dim"}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

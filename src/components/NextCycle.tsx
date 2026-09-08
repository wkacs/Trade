"use client";

import { useEffect, useState } from "react";
import { usEquitySession, nextSessionOpenMs, sessionCloseMs } from "@/lib/markets/calendar";

/**
 * Visszaszámláló a KÖVETKEZŐ döntési ciklusig.
 *
 * Szándékosan NEM „következő trade": azt egyetlen őszinte felület sem tudja megígérni.
 * A bot ciklusonként dönt, és kötés csak akkor lesz, ha a jel ÉS a kockázati kapu is
 * engedi. Ami előre tudható, az a ciklus ideje — ezt mutatjuk, a jelentésével együtt.
 *
 * Kriptó: óránkénti tick a :07 percnél (UTC), a GitHub Actions ütemezése szerint.
 * Részvény: az amerikai ülés alatt 5 perces ciklus; zárt piacnál a következő nyitásig.
 */
const CRYPTO_TICK_MINUTE = 7;
const STOCK_SLOT_MS = 5 * 60 * 1000;

export interface NextCycleState {
  /** Mennyi van hátra ms-ban. */
  remainingMs: number;
  /** Mi történik a ciklus idején — a számla melletti magyarázat. */
  label: string;
  /** Igaz, ha a sáv most alszik (zárt piac) — ilyenkor a szín is halkabb. */
  dormant: boolean;
}

/** Kriptó: a következő óra :07 perce (UTC). */
export function nextCryptoTickMs(nowMs: number): number {
  const d = new Date(nowMs);
  const target = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    CRYPTO_TICK_MINUTE,
    0,
    0,
  );
  return target > nowMs ? target : target + 60 * 60 * 1000;
}

/** Részvény: ülés alatt a következő 5 perces rács-pont, egyébként a következő nyitás. */
export function nextStockCycleMs(nowMs: number): { at: number; dormant: boolean } {
  if (usEquitySession(nowMs).open) {
    return { at: Math.floor(nowMs / STOCK_SLOT_MS) * STOCK_SLOT_MS + STOCK_SLOT_MS, dormant: false };
  }
  return { at: nextSessionOpenMs(nowMs), dormant: true };
}

/** Az amerikai ülés következő HATÁRPONTJA: nyitva a mai zárás, zárva a következő nyitás. */
export interface StockSessionInfo {
  open: boolean;
  /** A határpont ideje epoch ms-ban. */
  at: number;
  /** Rövid, fejlécbe való címke — pl. „zár 22:00" vagy „nyit hétfő 15:30". */
  chip: string;
}

/** Helyi idő. A tőzsde ET-ben jár, de a felhasználó a SAJÁT óráját nézi. */
function localTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
}

/** Igaz, ha a két időpont ugyanarra a HELYI naptári napra esik. */
function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  );
}

export function stockSessionInfo(nowMs: number): StockSessionInfo {
  const open = usEquitySession(nowMs).open;
  const close = sessionCloseMs(nowMs);
  const at = open && close !== null ? close : nextSessionOpenMs(nowMs);
  const verb = open ? "zár" : "nyit";
  const day = sameLocalDay(at, nowMs)
    ? ""
    : `${new Date(at).toLocaleDateString("hu-HU", { weekday: "long" })} `;
  return { open, at, chip: `${verb} ${day}${localTime(at)}` };
}

export function nextCycleState(lane: "crypto" | "stock", nowMs: number): NextCycleState {
  if (lane === "crypto") {
    return {
      remainingMs: nextCryptoTickMs(nowMs) - nowMs,
      label: "óránkénti döntés",
      dormant: false,
    };
  }
  const { at, dormant } = nextStockCycleMs(nowMs);
  return {
    remainingMs: at - nowMs,
    label: dormant ? "piac zárva · nyitásig" : "5 perces döntés",
    dormant,
  };
}

/** ms → `ó:pp:mm` vagy `pp:mm`, mindig kétjegyű mezőkkel. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function NextCycle({ lane }: { lane: "crypto" | "stock" }) {
  // A szerveren nincs „most": a mount utáni első tickig üres, így nincs hidratálási eltérés.
  const [state, setState] = useState<NextCycleState | null>(null);

  useEffect(() => {
    const tick = () => setState(nextCycleState(lane, Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lane]);

  const tone = lane === "crypto" ? "text-accentBright" : "text-info";
  return (
    <span className="flex items-baseline gap-2 font-mono text-[11px] text-faint">
      <span>{state ? state.label : "következő döntés"}</span>
      <span
        className={`tabular-nums ${state?.dormant ? "text-dim" : tone}`}
        aria-live="off"
        title="A ciklus indulásáig hátralévő idő. Kötés csak akkor lesz, ha a jel és a kockázati kapu is engedi."
      >
        {state ? formatCountdown(state.remainingMs) : "—"}
      </span>
    </span>
  );
}

/** A mostani időpont másodpercenként — a visszaszámlálók közös órája. */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Fejléc-címke: mikor zár (ha nyitva), vagy mikor nyit (ha zárva). */
export function StockSessionChip() {
  const now = useNow();
  if (now === null) return null;
  const info = stockSessionInfo(now);
  return (
    <span className="font-mono text-[11px] text-faint">
      <span className={info.open ? "text-info" : "text-dim"}>{info.chip}</span>
    </span>
  );
}

/**
 * A motor-állapot első sora: hol tart az ülés MOST. Nyitva a zárásig hátralévő idő,
 * zárva a következő nyitás — mindkettő helyi időben, mert a felhasználó azt nézi.
 */
export function StockSessionLine() {
  const now = useNow();
  if (now === null) return null;
  const info = stockSessionInfo(now);
  const remaining = formatCountdown(info.at - now);
  return (
    <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line pb-3 text-[12px]">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${info.open ? "bg-info" : "bg-faint"}`}
        aria-hidden
      />
      <span className={info.open ? "text-info" : "text-dim"}>
        {info.open ? "Ülés nyitva" : "Piac zárva"}
      </span>
      <span className="text-faint">·</span>
      <span className="text-dim">
        {info.open ? "zárás" : "nyitás"}{" "}
        <span className="text-ink">
          {new Date(info.at).toLocaleString("hu-HU", {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>{" "}
        (helyi idő)
      </span>
      <span className="text-faint">·</span>
      <span className="tabular-nums text-dim">hátra {remaining}</span>
    </p>
  );
}

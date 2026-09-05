/**
 * Állandó kereskedési worker (T22).
 *
 * Futtatás:
 *   pnpm worker                 → folyamatos futás (5 perces kilépés + 60 perces belépés)
 *   pnpm worker --once exit     → EGY kilépés-ciklus, majd kilép
 *   pnpm worker --once entry    → EGY belépés-ciklus, majd kilép
 *   pnpm worker --exit-ms 60000 → a kilépés ciklusideje (teszthez)
 *
 * Leállítás: Ctrl+C vagy SIGTERM. A folyamatban lévő ciklus befejeződik, új nem indul.
 *
 * Miért kell: a GitHub Actions ütemezés terhelés alatt késik, ezért a pontos 5 perces
 * kilépés nem bízható rá. A worker egyetlen írót garantál (lease + fencing token), és a
 * hosszú LLM-hívás nem foghatja meg a kilépést — külön hurok fut.
 */
import { config as dotenv } from "dotenv";

dotenv({ path: ".env.local" });
dotenv();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const { TradingWorker, realSleep } = await import("@/lib/engine/worker");
  const { acquireLease, releaseLease } = await import("@/lib/engine/run-lease");
  const { runFastExit } = await import("@/lib/engine/fast-exit");
  const { executeScheduledTick } = await import("@/lib/engine/run-scheduled-tick");
  const { loadPortfolioState } = await import("@/lib/portfolio/accounting");
  const { expireStaleReservations, listUnsettledIntents } = await import("@/lib/execution/order-store");
  const { getTradingMode, schedulerGuard } = await import("@/lib/config");

  const once = arg("once");
  const guard = schedulerGuard("worker");
  if (!guard.active && !once && !process.argv.includes("--force")) {
    // A FOLYAMATOS futás az, ami duplázna. Az egyszeri (`--once`) futás mehet.
    console.error(
      [
        `[worker] NEM indul: ${guard.message}`,
        "  Állandó workerhez: SCHEDULER=worker (és a GitHub Actions tick ekkor magától kihagy).",
        "  Kényszerített indítás (csak ha tudod, mit csinálsz): pnpm worker --force",
      ].join("\n"),
    );
    process.exit(2);
    return;
  }

  const portfolio = await loadPortfolioState();
  if (!portfolio) {
    console.error(
      "Nincs hiteles portfólió-állapot (DATABASE_URL vagy inicializált portfólió hiányzik). " +
        "A worker NEM indul: hiányzó DB nem aktiválhat ordert.",
    );
    process.exit(1);
    return;
  }
  const mode = getTradingMode();
  const scope = { portfolioId: portfolio.portfolioId, mode };

  // Indulási egyeztetés: a lejárt foglalások felszabadulnak, és megnézzük, maradt-e
  // ismeretlen állapotú megbízás. Ilyenkor a ciklusok maguk állnak meg.
  const released = await expireStaleReservations(scope);
  const unsettled = await listUnsettledIntents(scope);
  console.log(
    `[worker] indulás — portfólió ${scope.portfolioId} (${mode}), felszabadított foglalás: ${released}, ` +
      `egyeztetésre váró megbízás: ${unsettled.length}`,
  );
  if (unsettled.length > 0) {
    console.warn(
      "[worker] ⚠ ismeretlen állapotú megbízás(ok) vannak. A ciklusok NEM indítanak új ordert, " +
        "amíg ezek nincsenek egyeztetve (T25/T27).",
    );
  }

  const worker = new TradingWorker(
    {
      portfolioId: scope.portfolioId,
      mode,
      exitIntervalMs: Number(arg("exit-ms") ?? 5 * 60_000),
      entryIntervalMs: Number(arg("entry-ms") ?? 60 * 60_000),
      entryOffsetMs: Number(arg("entry-offset-ms") ?? 7 * 60_000),
    },
    {
      now: () => Date.now(),
      sleep: realSleep,
      acquireLease,
      releaseLease,
      runExit: async (slot) => {
        const r = await runFastExit({ portfolioId: scope.portfolioId, mode, cycleId: `exit-${slot}` });
        console.log(
          `[worker] exit ${slot}: ${r.fills.length} kilépés, ${r.stopUpdatesApplied} stop-frissítés, ` +
            `quote-kor ${r.quotes.maxAgeMs} ms${r.halted ? `, megállt: ${r.halted}` : ""} (${r.durationMs} ms)`,
        );
      },
      runEntry: async (slot) => {
        const r = await executeScheduledTick();
        console.log(
          `[worker] entry ${slot}: ${r.ok ? "ok" : "HIBA"} ${r.action ?? ""}${r.skipped ? ` (skip: ${r.reason})` : ""}` +
            `${r.error ? ` — ${r.error}` : ""}`,
        );
      },
      onEvent: (e) => {
        if (e.type === "skipped") console.warn(`[worker] ${e.kind} ${e.slot} kihagyva: ${e.reason}`);
        if (e.type === "error") console.error(`[worker] ${e.kind} ${e.slot} hiba: ${e.message}`);
      },
    },
  );

  if (once === "exit" || once === "entry") {
    const r = await worker.runOnce(once);
    console.log(`[worker] egyszeri ${once} futás: ${r.ran ? `lefutott (${r.slot})` : `kihagyva (${r.reason})`}`);
    return;
  }

  const shutdown = (signal: string) => {
    console.log(`[worker] ${signal} — leállítás, a folyamatban lévő ciklus befejeződik.`);
    worker.stop();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await worker.start();
  console.log(
    `[worker] leállt. Kilépés-ciklusok: ${worker.stats.exit.runs} (átfedés miatt kihagyva ${worker.stats.exit.skippedOverlap}), ` +
      `belépés-ciklusok: ${worker.stats.entry.runs}.`,
  );
}

main().catch((e) => {
  console.error("[worker] végzetes hiba:", e);
  process.exit(1);
});

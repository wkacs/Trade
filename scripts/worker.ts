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
  const { acquireLease, releaseLease, leaseKey, slotId, SLOT_MS } = await import("@/lib/engine/run-lease");
  const { runFastExit } = await import("@/lib/engine/fast-exit");
  const { executeScheduledStockIntraday } = await import("@/lib/engine/run-scheduled-stock-intraday");
  const { executeScheduledTick } = await import("@/lib/engine/run-scheduled-tick");
  const { loadPortfolioState } = await import("@/lib/portfolio/accounting");
  const { expireStaleReservations, listUnsettledIntents, loadLedgerState, listKnownFillIds, intentIdsByExchangeOrder, persistFill, recordProtectionOrder } = await import("@/lib/execution/order-store");
  const { applyFill } = await import("@/lib/portfolio/ledger");
  const { mul, dec } = await import("@/lib/portfolio/money");
  const { DEFAULT_STRATEGY } = await import("@/lib/strategy/config");
  const { BinanceLiveClient } = await import("@/lib/execution/binance-live");
  const { BinanceExecutionBroker } = await import("@/lib/execution/binance-broker");
  const { fetchSymbolFilters, pairFor } = await import("@/lib/execution/exchange-rules");
  const { reconcile, reconcileGate, formatReconcile } = await import("@/lib/execution/reconcile");
  const { COIN_UNIVERSE } = await import("@/lib/config");
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
  const liveClient = mode === "live"
    ? new BinanceLiveClient(process.env.BINANCE_API_KEY ?? "", process.env.BINANCE_API_SECRET ?? "")
    : null;
  let liveSnapshot: Awaited<ReturnType<InstanceType<typeof BinanceLiveClient>["snapshot"]>> | null = null;
  let liveFilters: Awaited<ReturnType<typeof fetchSymbolFilters>>["filters"] = {};

  const refreshLive = async () => {
    if (!liveClient) return;
    const filters = await fetchSymbolFilters(COIN_UNIVERSE.map((s) => pairFor(s)));
    if (filters.error) throw new Error(`exchangeInfo: ${filters.error.message}`);
    liveFilters = filters.filters;
    liveSnapshot = await liveClient.snapshot([...COIN_UNIVERSE]);
  };

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

  /**
   * RÉSZVÉNY day-trading ciklus az 5 perces kilépés-sávban.
   *
   * Miért itt: a részvény-sáv ritmusa is 5 perc, és a nap végi laposra zárás CSAK az ülés
   * utolsó 10 percében fut le — ha ebben a sávban senki nem hívja a ciklust, a pozíció
   * bent ragad éjszakára. A worker korábban egyáltalán nem indította a részvény-ágat, így
   * `SCHEDULER=worker` mellett a sáv néma volt: se belépő, se zárás. Ez ugyanaz a párosítás,
   * amit az éles `/api/cron/exit` route csinál.
   *
   * FÜGGETLEN a kripto kilépéstől: saját lease, saját hiba-ág. A részvény hibája nem
   * ronthatja el a kripto kilépés eredményét, ezért itt nyeljük el és naplózzuk.
   */
  const runStockIntraday = async () => {
    try {
      const r = await executeScheduledStockIntraday();
      if (r.skipped) return; // zárt piac / nincs aktív részvény — nem esemény
      const parts = [`fázis ${r.phase}`, `${r.actions?.length ?? 0} akció`];
      if (r.carryFlattened?.length) parts.push(`ÁTHOZOTT zárva: ${r.carryFlattened.join(", ")}`);
      if (r.unflattened?.length) parts.push(`NYITVA MARADT: ${r.unflattened.join(", ")}`);
      const line = `[worker] stock-intraday ${r.slot}: ${parts.join(", ")}`;
      if (r.ok) console.log(line);
      else console.error(`${line}${r.error ? ` — ${r.error}` : ""}`);
    } catch (e) {
      console.error("[worker] stock-intraday ciklus kivétel:", e);
    }
  };

  let worker: InstanceType<typeof TradingWorker>;
  worker = new TradingWorker(
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
      reconcile: mode === "live" ? async () => {
        const key = leaseKey("reconcile", slotId(Date.now(), SLOT_MS.reconcile));
        const lease = await acquireLease(key, worker.owner, Math.floor(SLOT_MS.reconcile * 0.9));
        if (!lease.acquired) return { safeToBuy: false, summary: "Az egyeztetési lease-t más folyamat tartja." };
        try {
          await refreshLive();
          for (const protection of Object.values(liveClient!.protectionFrom(liveSnapshot!))) {
            if (protection) await recordProtectionOrder(scope.portfolioId, protection.exchangeOrderId, protection.symbol);
          }
          let ledger = await loadLedgerState(scope);
          const intentMap = await intentIdsByExchangeOrder(scope);
          const known = await listKnownFillIds(scope);
          let result = reconcile(ledger, liveSnapshot!, mode, { knownFillIds: known, intentIdForOrder: intentMap });
          const fence = { leaseKey: key, owner: worker.owner, fencingToken: lease.fencingToken };
          // Csak a bot saját orderId-jához köthető fill importálható automatikusan. A kézi kötés
          // továbbra is blokkoló eltérés, mert annak eredetét nem találgatjuk.
          for (const fill of result.newFills.filter((f) => !f.intentId.startsWith("manual:"))) {
            const applied = applyFill(ledger, fill, {
              stopPrice: fill.side === "BUY" ? mul(fill.fillPrice, dec(1 - DEFAULT_STRATEGY.stopLossPct)) : undefined,
            });
            if (!applied.applied || !applied.deltas) continue;
            await persistFill({
              intentId: fill.intentId, portfolioId: scope.portfolioId, mode: "live", strategyVersion: "reconcile",
              origin: "manual", expiresAt: liveSnapshot!.fetchedAt, contractVersion: 2, referencePrice: fill.fillPrice,
              order: fill.side === "BUY"
                ? { side: "BUY", symbol: fill.symbol, maxQuoteSpend: fill.grossQuoteAmount }
                : { side: "SELL", symbol: fill.symbol, baseQty: fill.filledBaseQty },
            }, fill, { ...applied.deltas, fence });
            ledger = applied.state;
            known.push(fill.fillId);
          }
          result = reconcile(ledger, liveSnapshot!, mode, { knownFillIds: known, intentIdForOrder: intentMap });
          const gate = reconcileGate(result);
          return { safeToBuy: gate.allowNewBuys, summary: formatReconcile(result) };
        } finally {
          await releaseLease(key, worker.owner);
        }
      } : undefined,
      runExit: async (slot, context) => {
        if (liveClient) await refreshLive();
        const r = await runFastExit({
          portfolioId: scope.portfolioId,
          mode,
          cycleId: `exit-${slot}`,
          fence: { leaseKey: context.leaseKey, owner: context.owner, fencingToken: context.fencingToken },
          deps: liveClient && liveSnapshot ? {
            loadProtection: async () => liveClient.protectionFrom(liveSnapshot!),
            loadFilters: async () => Object.fromEntries(COIN_UNIVERSE.map((symbol) => [symbol, liveFilters[pairFor(symbol)]])),
            makeBroker: (_getLedger, _quotes, now) => new BinanceExecutionBroker({ http: liveClient, filters: liveFilters, now }),
            executeProtection: (actions) => liveClient.executeProtection(actions),
          } : undefined,
        });
        for (const outcome of r.protectionOutcomes) {
          if (outcome.ok && outcome.newOrderId) await recordProtectionOrder(scope.portfolioId, outcome.newOrderId, outcome.action.symbol);
        }
        worker.updateProtectionGate(!r.newBuysBlocked, r.protectionIncidents.map((i) => `[${i.code}] ${i.message}`).join("\n"));
        console.log(
          `[worker] exit ${slot}: ${r.fills.length} kilépés, ${r.stopUpdatesApplied} stop-frissítés, ` +
            `quote-kor ${r.quotes.maxAgeMs} ms${r.halted ? `, megállt: ${r.halted}` : ""} (${r.durationMs} ms)`,
        );
        await runStockIntraday();
      },
      runEntry: async (slot, context) => {
        const r = await executeScheduledTick({ owner: context.owner, allowNewBuys: context.allowNewBuys });
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

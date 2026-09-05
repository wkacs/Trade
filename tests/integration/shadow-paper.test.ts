import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetSchema, truncateAll } from "./db-helpers";
import { defineShadowSet } from "@/lib/backtest/shadow-accounts";
import { loadLedgerState, persistFill, seedLedger } from "@/lib/execution/order-store";
import { applyFill, emptyLedger } from "@/lib/portfolio/ledger";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import { EXECUTION_CONTRACT_VERSION, type ExecutionIntent, type Fill } from "@/lib/execution/contracts";

/**
 * T31 — valódi PostgreSQL határteszt. A setup kizárólag TEST_DATABASE_URL mellett
 * indul; a teszt azt bizonyítja, hogy egy baseline fill nem mozdítja a jelölt ledgerét.
 */
const accounts = () =>
  defineShadowSet(
    { id: "baseline", label: "alap", strategy: DEFAULT_STRATEGY },
    [{ id: "candidate", label: "jelölt", strategy: { ...DEFAULT_STRATEGY, stopMode: "atr" } }],
    { namespace: "it-shadow", startingCapitalUsd: 100 },
  );

const NOW = 1_700_000_000_000;

describe("shadow paper — elkülönített ledger", () => {
  beforeAll(async () => resetSchema(), 60_000);
  beforeEach(async () => truncateAll());

  it("azonos nyitótőkével indul, de a baseline fill nem folyik át a jelöltbe", async () => {
    const [baseline, candidate] = accounts();
    const baseScope = { portfolioId: baseline.portfolioId, mode: "paper" as const };
    const candidateScope = { portfolioId: candidate.portfolioId, mode: "paper" as const };
    await seedLedger(baseScope, "100", []);
    await seedLedger(candidateScope, "100", []);

    const fill: Fill = {
      fillId: "paper:shadow-buy:1",
      intentId: "shadow-buy",
      portfolioId: baseline.portfolioId,
      mode: "paper",
      symbol: "BTC",
      side: "BUY",
      exchangeOrderId: "shadow-buy",
      exchangeTradeId: "1",
      filledBaseQty: "0.001",
      grossQuoteAmount: "60",
      fillPrice: "60000",
      feeAmount: "0.06",
      feeAsset: "USDT",
      executedAt: NOW,
    };
    const intent: ExecutionIntent = {
      intentId: fill.intentId,
      portfolioId: baseline.portfolioId,
      mode: "paper",
      strategyVersion: "shadow/baseline",
      origin: "dca",
      expiresAt: NOW + 60_000,
      contractVersion: EXECUTION_CONTRACT_VERSION,
      referencePrice: "60000",
      order: { side: "BUY", symbol: "BTC", maxQuoteSpend: "60.06" },
    };
    const deltas = applyFill(emptyLedger(baseline.portfolioId, "paper", "100"), fill).deltas!;
    await persistFill(intent, fill, deltas);

    const afterBaseline = await loadLedgerState(baseScope);
    const afterCandidate = await loadLedgerState(candidateScope);
    expect(afterBaseline.positions.BTC.qty).toBe("0.001");
    expect(afterBaseline.cash.USDT).toBe("39.94");
    expect(afterCandidate.positions.BTC).toBeUndefined();
    expect(afterCandidate.cash.USDT).toBe("100");
  });
});

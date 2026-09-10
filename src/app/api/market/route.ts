import { NextResponse } from "next/server";
import { collectAllWithOutcomes, type DataCollector } from "@/lib/collectors/base";
import { pricesFromEvents, type PriceView } from "@/lib/market/price-view";
import { CoinGeckoCollector } from "@/lib/collectors/coingecko";
import { FearGreedCollector } from "@/lib/collectors/feargreed";
import { BinanceOHLCCollector } from "@/lib/collectors/binance";
import { buildFeatures } from "@/lib/ml/features";
import { predict } from "@/lib/ml/predictor";
import { loadPortfolioState } from "@/lib/portfolio/accounting";
import { remainingWeeklyBudget } from "@/lib/strategy/weekly-budget";
import { COIN_UNIVERSE, RISK_LIMITS, PROFIT_CYCLE, getTradingMode } from "@/lib/config";
import { dec } from "@/lib/portfolio/money";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import model from "@/lib/ml/model.json";

// Élő piaci adat (collectorok) — sosem prerenderelhető / cache-elhető.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * Piaci readout a dashboard terminálhoz: aktuális árak + 24h változás, Fear&Greed,
 * per-coin ML-jel, heti DCA-keret maradék, és a (hardcoded) kockázati/stratégia config.
 * A meglévő collectorokat + ML-t használja — ugyanazt, amit a tick lát.
 */
export async function GET() {
  try {
    const collectors: DataCollector[] = [
      new CoinGeckoCollector([...COIN_UNIVERSE]),
      new BinanceOHLCCollector([...COIN_UNIVERSE]),
      new FearGreedCollector(),
    ];
    const collected = await collectAllWithOutcomes(collectors);
    const events = collected.points;

    // Aktuális ár + 24h változás, forrás-prioritással (CoinGecko, majd Binance-tartalék).
    // A dashboard P&L-je ezen áll vagy bukik — lásd `market/price-view.ts`.
    const prices: Record<string, PriceView> = pricesFromEvents(events);

    // Fear & Greed.
    const fg = events.find((e) => e.kind === "sentiment" && e.sentiment)?.sentiment ?? null;

    // ML-jelek (a teljes events-ből, a Binance idősorral — mint a tick).
    const signals = (await predict(buildFeatures(events))).map((s) => ({
      symbol: s.symbol,
      direction1h: s.direction1h,
      confidence: s.confidence,
    }));

    // Heti DCA-keret maradék (equity = cash + pozíciók élő áron).
    const state = await loadPortfolioState();
    let weeklyBudgetRemainingUsd: number | null = null;
    if (state) {
      const equity =
        state.cashUsd +
        state.positions.reduce((s, p) => s + (prices[p.symbol]?.usd ?? p.entryPrice) * p.qty, 0);
      // A keret hatókör-helyes: csak EZ a portfólió és mód DCA-fill-jei és foglalásai
      // fogyasztják (T08). A megjelenítéshez number kell.
      weeklyBudgetRemainingUsd = Number(
        await remainingWeeklyBudget(dec(equity), { portfolioId: state.portfolioId, mode: getTradingMode() }),
      );
    }

    return NextResponse.json(
      {
        prices,
        fearGreed: fg,
        // Forrás-állapot: a néma degradáció (pl. HTTP 451 a Binance-tól) itt is látszik,
        // nem csak a tick-rekordban.
        sources: collected.outcomes.map((o) => ({
          name: o.name,
          ok: o.ok,
          points: o.points,
          error: o.error ?? null,
        })),
        signals,
        weeklyBudgetRemainingUsd,
        mlAuc: (model as { metrics?: { testAuc?: number } }).metrics?.testAuc ?? null,
        config: {
          maxPositionPct: RISK_LIMITS.maxPositionPct,
          stopLossPct: RISK_LIMITS.stopLossPct,
          maxConcurrentPositions: RISK_LIMITS.maxConcurrentPositions,
          dailyLossCircuitBreakerPct: RISK_LIMITS.dailyLossCircuitBreakerPct,
          takeProfitPct: PROFIT_CYCLE.takeProfitPct,
          dcaFgThreshold: PROFIT_CYCLE.dcaFgThreshold,
          dcaWeeklyBudgetPct: PROFIT_CYCLE.dcaWeeklyBudgetPct,
          dcaBuyPct: PROFIT_CYCLE.dcaBuyPct,
          entryFilter: DEFAULT_STRATEGY.entryFilter,
          takeProfitFraction: DEFAULT_STRATEGY.takeProfitFraction,
        },
      },
      noStore,
    );
  } catch (e) {
    console.error("[api/market]", e);
    return NextResponse.json({ error: "market hiba", detail: String(e) }, { status: 500, ...noStore });
  }
}

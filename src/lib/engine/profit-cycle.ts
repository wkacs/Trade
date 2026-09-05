import type { StrategyConfig } from "@/lib/strategy/config";
import { evaluatePosition } from "@/lib/strategy/position-actions";
import { evaluateDca } from "@/lib/strategy/fear-greedy";
import { evaluateMomentum, passesMomentum } from "@/lib/strategy/momentum";
import { ratchetStop } from "@/lib/strategy/trailing-stop";
import { passesTrendFilter } from "@/lib/strategy/entry-filter";
import { computeAtr } from "@/lib/strategy/atr";

/**
 * Egy symbolhoz tartozó stratégiai jelek (T15) — a TICK és a BACKTEST UGYANEZT hívja,
 * így nincs drift a két úton. A bemenet VALÓDI high/low-t hordozó, LEZÁRT gyertyasor.
 */
export interface SymbolSignals {
  /** Hány hézagmentes gyertya áll rendelkezésre a sorozat végén. */
  bars: number;
  /** Hány gyertya KELLENE a stratégia legnagyobb visszatekintéséhez + warmuphoz. */
  requiredBars: number;
  /** Igaz, ha van elég adat. Hamis esetén NINCS trend- és momentum-engedély. */
  sufficient: boolean;
  atr: number;
  trendOk: boolean;
  momentumOk: boolean;
}

export interface SignalCandle {
  openTime: number;
  high: number;
  low: number;
  close: number;
}

/**
 * A stratégia legnagyobb visszatekintése + bemelegítés, gyertyában.
 * Az audit §6 példája: a momentum 48 órás ablakot kér, a collector 24-et adott.
 */
export function strategyRequiredBars(config: StrategyConfig): number {
  return Math.max(
    config.entryFilterSmaPeriod,
    config.momentumSmaPeriod,
    config.momentumLookback,
    config.atrPeriod + 1,
  );
}

/** A sorozat VÉGÉN lévő, hézagmentes gyertyák száma (a rés előtti adat nem számít). */
export function contiguousTail(candles: SignalCandle[], stepMs: number): number {
  if (candles.length === 0) return 0;
  let n = 1;
  for (let i = candles.length - 1; i > 0; i--) {
    if (candles[i].openTime - candles[i - 1].openTime === stepMs) n++;
    else break;
  }
  return n;
}

/**
 * Stratégiai jelek egy symbolra. HIÁNYOS vagy RÉSES adat esetén `sufficient: false`,
 * és se trend-, se momentum-engedély nincs — a réses sor nem kap automatikus zöld utat.
 */
export function computeSymbolSignals(
  candles: SignalCandle[],
  config: StrategyConfig,
  stepMs: number,
): SymbolSignals {
  const required = strategyRequiredBars(config);
  const tail = contiguousTail(candles, stepMs);
  if (tail < required) {
    return { bars: tail, requiredBars: required, sufficient: false, atr: 0, trendOk: false, momentumOk: false };
  }
  const window = candles.slice(-tail);
  const closes = window.map((c) => c.close);
  return {
    bars: tail,
    requiredBars: required,
    sufficient: true,
    // VALÓDI high/low — a close-only ATR alulbecsülte a volatilitást.
    atr: computeAtr(window, config.atrPeriod),
    trendOk: passesTrendFilter(closes, config.entryFilterSmaPeriod),
    momentumOk: passesMomentum(closes, config.momentumSmaPeriod, config.momentumLookback),
  };
}

/** Több symbol jelei egyszerre — a tick és a backtest ugyanezt a formát adja tovább. */
export function computeAllSignals(
  candlesBySymbol: Record<string, SignalCandle[]>,
  config: StrategyConfig,
  stepMs: number,
): Record<string, SymbolSignals> {
  const out: Record<string, SymbolSignals> = {};
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    out[symbol] = computeSymbolSignals(candles, config, stepMs);
  }
  return out;
}

export interface PlannedOrder {
  kind: "stop-loss" | "take-profit" | "dca" | "momentum";
  side: "BUY" | "SELL";
  symbol: string;
  qty?: number; // SELL (stop/TP)
  amountUsd?: number; // BUY (DCA)
  triggerPrice?: number; // SELL fill-referencia
  reason: string;
}

export interface StopUpdate {
  positionId: string;
  newStop: number;
}

export interface ProfitCyclePlan {
  orders: PlannedOrder[];
  stopUpdates: StopUpdate[];
}

export interface ProfitCycleInput {
  positions: { id: string; symbol: string; qty: number; entryPrice: number; stopPrice: number }[];
  candles: Record<string, { low: number; high: number; close: number }>;
  fearGreedValue: number | null;
  coinChanges: { symbol: string; change24hPct: number }[];
  weeklyBudgetRemainingUsd: number;
  totalEquity: number;
  /** Per-symbol ATR (a hívó számolja). atr módban a stop-távolsághoz; fixed módban ignorált. */
  atrBySymbol: Record<string, number>;
  /** Per-symbol trend-flag (close ≥ SMA). trend módban a DCA-jogosultsághoz; off módban ignorált. */
  trendOkBySymbol: Record<string, boolean>;
  /** Per-symbol momentum-flag (breakout a trend fölött). A hívó számolja; momentumEnabled ki → ignorált. */
  momentumOkBySymbol?: Record<string, boolean>;
}

/**
 * A kód-alapú profit-ciklus DÖNTÉS-része, tisztán (nincs IO/DB/Date.now). A stratégiát
 * a `config` (StrategyConfig) vezérli. Sorrend (a runTick tükre): stop/TP az eredeti
 * stoppal → trailing ratchet (mód szerint) → DCA (szűrővel).
 * A hívó hajtja végre az ordereket + perzisztálja a stopUpdate-eket.
 */
export function planProfitCycle(input: ProfitCycleInput, config: StrategyConfig): ProfitCyclePlan {
  const orders: PlannedOrder[] = [];
  const stopUpdates: StopUpdate[] = [];

  for (const p of input.positions) {
    const candle = input.candles[p.symbol];
    if (!candle) continue;

    // 1) Stop/TP az EREDETI (előző gyertyából hozott) stoppal — NINCS look-ahead.
    const action = evaluatePosition(
      {
        positionId: p.id,
        symbol: p.symbol,
        qty: p.qty,
        entryPrice: p.entryPrice,
        stopPrice: p.stopPrice,
        low: candle.low,
        high: candle.high,
        close: candle.close,
      },
      { takeProfitPct: config.takeProfitPct, takeProfitFraction: config.takeProfitFraction },
    );
    if (action.kind !== "none") {
      orders.push({
        kind: action.kind,
        side: "SELL",
        symbol: p.symbol,
        qty: p.qty * action.qtyFraction,
        triggerPrice: action.triggerPrice,
        reason: action.reason,
      });
    }

    // 2) Trailing ratchet → a KÖVETKEZŐ gyertya stopja. Mód szerint a stop-távolság:
    //    atr → close − atrMult*ATR; fixed → close*(1−stopLossPct). Csak felfelé kúszik.
    const atr = input.atrBySymbol[p.symbol] ?? 0;
    const candidate =
      config.stopMode === "atr" && atr > 0
        ? candle.close - config.atrMult * atr
        : candle.close * (1 - config.stopLossPct);
    const newStop = ratchetStop(p.stopPrice, candidate, 0); // pct=0 → max(prevStop, candidate)
    if (newStop > p.stopPrice) stopUpdates.push({ positionId: p.id, newStop });
  }

  // 3) Fear-greedy DCA (config + belépő-szűrő).
  const dca = evaluateDca(
    {
      fearGreedValue: input.fearGreedValue,
      coinChanges: input.coinChanges,
      weeklyBudgetRemainingUsd: input.weeklyBudgetRemainingUsd,
      totalEquity: input.totalEquity,
      trendOkBySymbol: input.trendOkBySymbol,
    },
    {
      dcaFgThreshold: config.dcaFgThreshold,
      dcaMax24hDropPct: config.dcaMax24hDropPct,
      dcaBuyPct: config.dcaBuyPct,
      entryFilter: config.entryFilter,
      riskPerTradePct: config.riskPerTradePct,
      stopLossPct: config.stopLossPct,
      stopMode: config.stopMode,
      maxPositionPct: config.maxPositionPct,
    },
  );
  if (dca.shouldAccumulate && dca.symbol) {
    orders.push({
      kind: "dca",
      side: "BUY",
      symbol: dca.symbol,
      amountUsd: dca.amountUsd,
      reason: dca.reason,
    });
  }

  // 4) Momentum-belépő (vesz az erőben). A concurrent-cap CSAK az új momentum-belépőre
  //    vonatkozik (a DCA viselkedése változatlan, hogy a backteszt-baseline ne mozduljon).
  const mom = evaluateMomentum(
    {
      momentumOkBySymbol: input.momentumOkBySymbol ?? {},
      coinChanges: input.coinChanges,
      heldSymbols: input.positions.map((p) => p.symbol),
      openPositionCount: input.positions.length,
      totalEquity: input.totalEquity,
    },
    {
      momentumEnabled: config.momentumEnabled,
      momentumBuyPct: config.momentumBuyPct,
      maxConcurrentPositions: config.maxConcurrentPositions,
      riskPerTradePct: config.riskPerTradePct,
      stopLossPct: config.stopLossPct,
      stopMode: config.stopMode,
      maxPositionPct: config.maxPositionPct,
    },
  );
  if (mom.shouldEnter && mom.symbol) {
    orders.push({ kind: "momentum", side: "BUY", symbol: mom.symbol, amountUsd: mom.amountUsd, reason: mom.reason });
  }

  return { orders, stopUpdates };
}

/** Egy órás OHLC gyertya. */
export interface Candle {
  ts: number; // epoch ms (a gyertya nyitó órája)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Egy órás, time-aligned piaci keret: symbolonkénti gyertya + Fear&Greed. */
export interface HistoryFrame {
  ts: number;
  candles: Record<string, Candle>; // symbol -> gyertya (egy-egy symbol hiányozhat)
  fearGreedValue: number | null;
}

export interface BacktestConfig {
  symbols: string[]; // default COIN_UNIVERSE
  initialCapitalUsd: number; // default 10000
  feePct: number; // default 0.001
  slippageBps: number; // default 5
}

export interface EquityPoint {
  ts: number;
  equityUsd: number;
}

/** Egy LEZÁRT (teljesen eladott) pozíció realizált eredménye. */
export interface ClosedTradePnl {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnlUsd: number;
  pnlPct: number;
}

export interface BacktestMetrics {
  totalReturnPct: number;
  sharpe: number; // annualizált (√8760)
  maxDrawdownPct: number; // pozitív szám (pl. 0.23 = -23% lehúzás)
  hitRate: number; // 0..1
  tradesCount: number; // lezárt pozíciók száma
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number; // Σwin / |Σloss|; loss nélkül Infinity
  exposurePct: number; // piacban töltött órák aránya
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  closedTrades: ClosedTradePnl[];
  config: BacktestConfig;
  from: number;
  to: number;
}

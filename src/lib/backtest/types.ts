import type { ExecutionModel } from "./fill-sim";

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
  /**
   * A végrehajtási mód (T17). `polling` = a futó bot valósága (időnkénti pillanatkép,
   * market order a KÖVETKEZŐ áron). `exchange-stop` = a tőzsdén ülő védőorder, ami a
   * gyertyán belül is tüzel. A kettő NEM ugyanaz, ezért külön mérendő.
   */
  executionModel?: ExecutionModel;
  /** Minimum kötésérték quote-ban (tőzsdei minimum notional). */
  minOrderQuote?: number;
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

/** Egy realizálási esemény — a RÉSZLEGES zárás is ilyen (T18). */
export interface RealizationEvent {
  ts: number;
  symbol: string;
  qty: number;
  exitPrice: number;
  /** A díjak UTÁNI realizált eredmény quote-ban. */
  pnlUsd: number;
  /** Az elszámolt arányos bekerülési érték. */
  costBasisUsd: number;
  feeUsd: number;
  /** Igaz, ha ezzel a művelettel a pozíció teljesen lezárult. */
  closesPosition: boolean;
  kind: "stop-loss" | "take-profit" | "market";
}

/**
 * Egy BELÉPÉS (BUY teljesülés). A kilépési ütem izolált vizsgálatához (T30) kell:
 * csak akkor hasonlítható össze két kilépési sűrűség, ha a belépések AZONOSAK.
 */
export interface EntryEvent {
  ts: number;
  symbol: string;
  qty: number;
  fillPrice: number;
  amountUsd: number;
  feeUsd: number;
  kind: "dca" | "momentum" | "ai";
}

export interface BacktestMetrics {
  totalReturnPct: number;
  /** Annualizált Sharpe a TÉNYLEGES mintavételi közhöz igazítva. */
  sharpe: number;
  maxDrawdownPct: number; // pozitív szám (pl. 0.23 = -23% lehúzás)
  hitRate: number; // 0..1
  tradesCount: number; // realizálási események száma
  avgWinPct: number;
  avgLossPct: number;
  /**
   * Σwin / |Σloss|. Veszteség nélkül nincs értelmes hányados: ilyenkor `null`, és a
   * `profitFactorInfinite` jelzi az okot (JSON-biztos, nem Infinity).
   */
  profitFactor: number | null;
  profitFactorInfinite: boolean;
  exposurePct: number; // piacban töltött órák aránya
  /** Összes díj quote-ban — a nettó eredmény ellenőrzéséhez. */
  totalFeesUsd: number;
  /** Az equity-görbe mintavételi köze órában (a Sharpe évesítéséhez). */
  samplingHours: number;
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  closedTrades: ClosedTradePnl[];
  /** MINDEN realizálás, a részlegesek is (T18). */
  realizations: RealizationEvent[];
  /** MINDEN belépés — a kilépési ütem izolált vizsgálatához (T30). */
  entries: EntryEvent[];
  config: BacktestConfig;
  from: number;
  to: number;
  /** Miért nem lett order — a kockázati kapu elutasításai kódonként. */
  rejections: Record<string, number>;
}

export type { ExecutionModel };

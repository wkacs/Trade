import type { DataPoint } from "@/lib/types";
import { candlesFromDataPoints } from "@/lib/collectors/binance";
import { assessHistory, TIMEFRAME_MS, type OhlcvCandle, type Timeframe } from "@/lib/market/candles";

/**
 * Feature engineering (T13) — a TRÉNING és a FUTÁS ugyanebből a függvényből dolgozik.
 *
 * Az audit §5 bizonyította a régi hibákat:
 *  - a `volumeRatio` a Binance ÓRÁS mennyiségét keverte a CoinGecko 24 ÓRÁS volumenével,
 *    mert a `DataPoint.price.volume24h` mezőt mindkét forrás töltötte;
 *  - a visszatekintés ELEMSZÁMMAL volt mérve, nem időkerettel, ezért réses sor esetén a
 *    „4 órás" hozam valójában több óra távolságot fogott át;
 *  - a nem lezárt gyertya is bekerült.
 *
 * Mostantól a bemenet KIZÁRÓLAG lezárt, hézagmentes OHLCV-sorozat, a mennyiség a gyertya
 * saját base-volumene, és hiányos adatnál NINCS feature — nem születik gyenge jel.
 */
export interface MlFeatures {
  symbol: string;
  return1h: number;
  return4h: number;
  volatility4h: number;
  /** A záró gyertya base-volumene az ablak átlagához képest (>1 = felfutó forgalom). */
  volumeRatio: number;
  /** A feature-készlet verziója — a modellartefaktumnak EZZEL kell egyeznie. */
  featureVersion: string;
  /** A legutolsó felhasznált gyertya záró ideje (a jel kora ebből mérhető). */
  asOf: number;
  timeframe: Timeframe;
}

/**
 * A feature-készlet verziója. VÁLTOZTASD, ha bármelyik feature JELENTÉSE módosul.
 * A régi modellt tilos új jelentésű feature-ökkel tovább használni.
 */
export const FEATURE_VERSION = "f2-2026-09-05";

/** A feature-ök sorrendje — a modell súlyai ehhez a sorrendhez tartoznak. */
export const FEATURE_NAMES = ["return1h", "return4h", "volatility4h", "volumeRatio"] as const;

export interface FeatureConfig {
  timeframe: Timeframe;
  /** Rövid hozam ablaka gyertyában (1h keretnél 1). */
  shortBars: number;
  /** Hosszabb hozam és volatilitás ablaka gyertyában (1h keretnél 4). */
  windowBars: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  timeframe: "1h",
  shortBars: 1,
  windowBars: 4,
};

/** A feature-építéshez szükséges HÉZAGMENTES gyertyaszám. */
export function featureWarmupBars(config: FeatureConfig = DEFAULT_FEATURE_CONFIG): number {
  return config.windowBars + 1;
}

export type FeatureSkipReason = "insufficient_history" | "gap_in_window" | "invalid_values";

export interface FeatureResult {
  features: MlFeatures | null;
  reason?: FeatureSkipReason;
}

/**
 * Egy symbol feature-ei LEZÁRT gyertyákból. Hiányos vagy réses ablak esetén `null` —
 * a hiányzó bemenet nem kaphat kitalált jelet.
 */
export function buildFeaturesFromCandles(
  candles: OhlcvCandle[],
  config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): FeatureResult {
  const needed = featureWarmupBars(config);
  const quality = assessHistory(candles, config.timeframe, needed);
  if (!quality.sufficient) {
    return { features: null, reason: quality.count < needed ? "insufficient_history" : "gap_in_window" };
  }

  // Csak a hézagmentes VÉGET használjuk — a rés előtti adat nem keveredhet be.
  const step = TIMEFRAME_MS[config.timeframe];
  const window = candles.slice(-quality.contiguousTail);
  const last = window[window.length - 1];
  const prevShort = window[window.length - 1 - config.shortBars];
  const prevWindow = window[window.length - 1 - config.windowBars];
  if (!prevShort || !prevWindow) return { features: null, reason: "insufficient_history" };

  // Idő-ellenőrzés: a visszatekintés az IDŐKERETHEZ tartozik, nem az elemszámhoz.
  if (last.openTime - prevShort.openTime !== step * config.shortBars) {
    return { features: null, reason: "gap_in_window" };
  }
  if (last.openTime - prevWindow.openTime !== step * config.windowBars) {
    return { features: null, reason: "gap_in_window" };
  }

  const closes = window.slice(-(config.windowBars + 1)).map((c) => c.close);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length || 1);

  // A mennyiség a GYERTYA SAJÁT base-volumene — nincs 24 órás CoinGecko keveredés.
  const vols = window.slice(-(config.windowBars + 1)).map((c) => c.baseVolume);
  const meanVol = vols.reduce((s, v) => s + v, 0) / (vols.length || 1);

  const features: MlFeatures = {
    symbol: last.symbol,
    return1h: (last.close - prevShort.close) / prevShort.close,
    return4h: (last.close - prevWindow.close) / prevWindow.close,
    volatility4h: Math.sqrt(variance),
    volumeRatio: meanVol > 0 ? last.baseVolume / meanVol : 1,
    featureVersion: FEATURE_VERSION,
    asOf: last.closeTime,
    timeframe: config.timeframe,
  };

  const values = [features.return1h, features.return4h, features.volatility4h, features.volumeRatio];
  if (values.some((v) => !Number.isFinite(v))) return { features: null, reason: "invalid_values" };
  return { features };
}

/** A feature-vektor a modell súly-sorrendjében. */
export function featureVector(f: MlFeatures): number[] {
  return [f.return1h, f.return4h, f.volatility4h, f.volumeRatio];
}

export interface BuildFeaturesResult {
  features: MlFeatures[];
  /** Miért maradt ki egy symbol — a hiányzó jel LÁTHATÓ, nem néma. */
  skipped: { symbol: string; reason: FeatureSkipReason }[];
}

/**
 * Adatgyűjtő-események → feature-ök. CSAK a `binance` forrás lezárt OHLCV-jét használja;
 * a CoinGecko ár-pont nem alkalmas modellezésre (nincs high/low, más volumen-jelentés).
 */
export function buildFeaturesWithDiagnostics(
  events: DataPoint[],
  config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): BuildFeaturesResult {
  const symbols = Array.from(
    new Set(events.filter((e) => e.source === "binance" && e.ohlcv).map((e) => e.symbol)),
  );
  const features: MlFeatures[] = [];
  const skipped: BuildFeaturesResult["skipped"] = [];
  for (const symbol of symbols) {
    const candles = candlesFromDataPoints(events, symbol);
    const r = buildFeaturesFromCandles(candles, config);
    if (r.features) features.push(r.features);
    else skipped.push({ symbol, reason: r.reason ?? "insufficient_history" });
  }
  return { features, skipped };
}

/** Visszafelé kompatibilis alak (csak a feature-lista). */
export function buildFeatures(events: DataPoint[], config: FeatureConfig = DEFAULT_FEATURE_CONFIG): MlFeatures[] {
  return buildFeaturesWithDiagnostics(events, config).features;
}

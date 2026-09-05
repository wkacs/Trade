import { describe, it, expect } from "vitest";
import {
  buildFeatures,
  buildFeaturesWithDiagnostics,
  buildFeaturesFromCandles,
  featureVector,
  featureWarmupBars,
  FEATURE_NAMES,
  FEATURE_VERSION,
  DEFAULT_FEATURE_CONFIG,
} from "@/lib/ml/features";
import { candleToDataPoint } from "@/lib/collectors/binance";
import type { OhlcvCandle } from "@/lib/market/candles";
import type { DataPoint } from "@/lib/types";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

function candle(openTime: number, close: number, baseVolume = 10, quoteVolume = 1000): OhlcvCandle {
  return {
    symbol: "BTC",
    timeframe: "1h",
    openTime,
    closeTime: openTime + HOUR - 1,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    baseVolume,
    quoteVolume,
    trades: 10,
    receivedAt: NOW,
  };
}

/** N óra hosszú, hézagmentes sorozat, a legutolsó gyertya `NOW - HOUR` órában nyit. */
function series(closes: number[], volumes?: number[]): OhlcvCandle[] {
  const n = closes.length;
  return closes.map((c, i) => candle(NOW - (n - i) * HOUR, c, volumes?.[i] ?? 10));
}

describe("feature-paritás — a tréning és a futás ugyanabból az ablakból számol", () => {
  it("ugyanaz a gyertyasor UGYANAZT a feature-vektort adja gyertyából és DataPointból", () => {
    const candles = series([100, 101, 102, 103, 104, 105]);
    const fromCandles = buildFeaturesFromCandles(candles).features!;
    const events: DataPoint[] = candles.map(candleToDataPoint);
    const fromEvents = buildFeatures(events)[0];
    expect(featureVector(fromEvents)).toEqual(featureVector(fromCandles));
    expect(fromEvents.asOf).toBe(fromCandles.asOf);
  });

  it("a feature-vektor sorrendje a modell súly-sorrendje", () => {
    const f = buildFeaturesFromCandles(series([100, 101, 102, 103, 104, 105])).features!;
    expect(FEATURE_NAMES).toEqual(["return1h", "return4h", "volatility4h", "volumeRatio"]);
    expect(featureVector(f)).toEqual([f.return1h, f.return4h, f.volatility4h, f.volumeRatio]);
  });

  it("minden feature hordozza a feature-verziót", () => {
    const f = buildFeaturesFromCandles(series([100, 101, 102, 103, 104, 105])).features!;
    expect(f.featureVersion).toBe(FEATURE_VERSION);
  });

  it("a hozamok a MEGADOTT időtávra vonatkoznak", () => {
    const f = buildFeaturesFromCandles(series([100, 100, 100, 100, 100, 110])).features!;
    // 1h: 100 → 110
    expect(f.return1h).toBeCloseTo(0.1, 12);
    // 4h: az utolsó előtti 4. gyertya zárása is 100 volt
    expect(f.return4h).toBeCloseTo(0.1, 12);
  });
});

describe("feature-ök — nincs volumen-keveredés, nincs jel hiányos adatból", () => {
  it("AUDIT §5: a volumenarány a GYERTYA base-volumenéből számol", () => {
    const candles = series([100, 100, 100, 100, 100, 100], [10, 10, 10, 10, 10, 30]);
    const f = buildFeaturesFromCandles(candles).features!;
    // Az ablak (5 gyertya) átlaga (10+10+10+10+30)/5 = 14; az utolsó 30 → 30/14.
    expect(f.volumeRatio).toBeCloseTo(30 / 14, 9);
  });

  it("a CoinGecko ár-pontokat FIGYELMEN KÍVÜL hagyja (nincs 24h volumen-keveredés)", () => {
    const cg: DataPoint[] = [
      { source: "coingecko", symbol: "BTC", timestamp: NOW, kind: "price", price: { usd: 60000, volume24h: 1e10, change24hPct: 1 } },
      { source: "coingecko", symbol: "BTC", timestamp: NOW - HOUR, kind: "price", price: { usd: 59000, volume24h: 1e10, change24hPct: 1 } },
    ];
    expect(buildFeatures(cg)).toEqual([]);
  });

  it("kevés gyertya → NINCS feature (nem gyenge jel)", () => {
    const r = buildFeaturesFromCandles(series([100, 101]));
    expect(r.features).toBeNull();
    expect(r.reason).toBe("insufficient_history");
  });

  it("az ablakon belüli RÉS miatt nincs feature", () => {
    const c = series([100, 101, 102, 103, 104, 105]);
    // Kiveszünk egy középső gyertyát → rés keletkezik a végén lévő ablakban.
    const gapped = [...c.slice(0, 2), ...c.slice(3)];
    const r = buildFeaturesFromCandles(gapped);
    expect(r.features).toBeNull();
    expect(r.reason).toBe("gap_in_window");
  });

  it("a kihagyás DIAGNOSZTIKÁVAL látszik, nem némán", () => {
    const events = series([100, 101]).map(candleToDataPoint);
    const r = buildFeaturesWithDiagnostics(events);
    expect(r.features).toEqual([]);
    expect(r.skipped).toEqual([{ symbol: "BTC", reason: "insufficient_history" }]);
  });

  it("a szükséges warmup explicit", () => {
    expect(featureWarmupBars(DEFAULT_FEATURE_CONFIG)).toBe(5);
  });

  it("nem lezárt gyertya nem kerülhet be (a collector szűri), így a feature is múltbeli", () => {
    const f = buildFeaturesFromCandles(series([100, 101, 102, 103, 104, 105])).features!;
    expect(f.asOf).toBeLessThanOrEqual(NOW);
  });
});

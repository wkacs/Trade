/**
 * Egységes piaci-adat réteg — a gyertyákat az instrumentum eszközosztálya szerint a
 * megfelelő providertől tölti:
 *   - crypto → Binance klines (1h, USDT-pár), a meglévő `fetchClosedCandles`
 *   - stock  → Yahoo napi chart-JSON (1d, USD), a `fetchYahooDailyCandles`
 *     (a Stooq-út megmarad a modulban, de 2026-09-08 óta bot-ellenőrzés mögött van)
 *
 * A kimenet egységes (`InstrumentCandles`), így a hívó (backteszt, engine, dashboard)
 * nem tud a forrás különbségéről. A hiba MINDIG strukturált — a néma üres sorozat tilos.
 *
 * FONTOS: a történet-lekérés NEM függ a piac nyitva-lététől (zárt piacon is van lezárt
 * gyertya-múlt). A „szabad-e MOST kereskedni" külön kérdés → `markets/tradability`.
 */

import type { OhlcvCandle, Timeframe } from "@/lib/market/candles";
import { fetchClosedCandles } from "@/lib/market/candles";
import { fetchStooqDailyCandles } from "./stooq";
import { fetchYahooCandles } from "./yahoo";
import { activeInstruments, type Instrument, type MarketEnv, type AssetClass } from "./registry";

/**
 * Az eszközosztály NATÍV időkerete. Ez az alapértelmezés; aki intraday-en dolgozik
 * (a day-trading részvény-ciklus), explicit `timeframe`-et ad a lekéréshez.
 */
export function timeframeFor(assetClass: AssetClass): Timeframe {
  return assetClass === "stock" ? "1d" : "1h";
}

export interface InstrumentCandles {
  instrument: Instrument;
  timeframe: Timeframe;
  candles: OhlcvCandle[];
  /** Strukturált hiba, ha a lekérés (részben) elbukott — NEM csendes üres sorozat. */
  error: { code: string; message: string } | null;
}

/**
 * Hihetetlen ár-ugrás két EGYMÁST KÖVETŐ gyertya záróárai között.
 *
 * Miért kell: a szolgáltató hibája, egy rossz tick, vagy egy még nem korrigált vállalati
 * esemény (split) olyan sorozatot adhat, amin a stratégia „kitörést" vagy „összeomlást"
 * lát ott, ahol csak adathiba van. A Yahoo a splitet visszamenőleg korrigálja, de erre
 * NEM támaszkodunk vakon: a fail-closed viselkedés az, hogy a gyanús sorozatot NEM
 * használjuk (a hívó kihagyja az instrumentumot), nem az, hogy kereskedünk rajta.
 *
 * A küszöb időkeret-függő: 5 perces baron a 20%-os ugrás gyakorlatilag lehetetlen, napi
 * baron viszont egy gyorsjelentés utáni 30% valós lehet.
 */
export function detectPriceAnomaly(
  candles: OhlcvCandle[],
  timeframe: Timeframe,
): { index: number; from: number; to: number; changePct: number } | null {
  const limit = timeframe === "1d" ? 0.45 : 0.2;
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const cur = candles[i].close;
    if (!(prev > 0) || !(cur > 0)) continue;
    const change = Math.abs(cur / prev - 1);
    if (change > limit) {
      return { index: i, from: prev, to: cur, changePct: change * 100 };
    }
  }
  return null;
}

export interface FetchOptions {
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Felülírja az eszközosztály natív időkeretét (pl. részvény intraday: "5m"). */
  timeframe?: Timeframe;
}

/**
 * Egy instrumentum lezárt gyertyáinak lekérése a saját providerétől.
 * A base szimbólumot és a quote-ot az instrumentum hordozza (nincs beégetett USDT).
 */
export async function fetchInstrumentCandles(
  instrument: Instrument,
  bars: number,
  opts: FetchOptions = {},
): Promise<InstrumentCandles> {
  const timeframe = opts.timeframe ?? timeframeFor(instrument.assetClass);

  if (instrument.dataProvider === "yahoo") {
    const res = await fetchYahooCandles(instrument.providerSymbol, instrument.symbol, bars, timeframe, opts);
    const anomaly = res.error ? null : detectPriceAnomaly(res.candles, timeframe);
    if (anomaly) {
      return {
        instrument,
        timeframe,
        candles: [],
        error: {
          code: "suspect_series",
          message:
            `Hihetetlen ár-ugrás (${instrument.symbol}): ${anomaly.from} → ${anomaly.to} ` +
            `(${anomaly.changePct.toFixed(1)}%) a ${anomaly.index}. gyertyánál — a sorozat nem használható.`,
        },
      };
    }
    return { instrument, timeframe, candles: res.candles, error: res.error };
  }

  if (instrument.dataProvider === "stooq") {
    const res = await fetchStooqDailyCandles(instrument.providerSymbol, instrument.symbol, bars, opts);
    return { instrument, timeframe, candles: res.candles, error: res.error };
  }

  // crypto / binance
  const res = await fetchClosedCandles(instrument.providerSymbol, timeframe, bars, {
    now: opts.now,
    fetchImpl: opts.fetchImpl,
    quotePair: instrument.quote,
  });
  return {
    instrument,
    timeframe,
    candles: res.candles,
    error: res.error ? { code: res.error.code, message: res.error.message } : null,
  };
}

/**
 * Az összes AKTÍV instrumentum gyertyáinak lekérése (env-vezérelt univerzum).
 * A providerek hívása párhuzamos; egy instrumentum hibája nem dönti el a többit.
 */
export async function fetchActiveCandles(
  bars: number,
  opts: FetchOptions & { env?: MarketEnv } = {},
): Promise<InstrumentCandles[]> {
  const { env, ...fetchOpts } = opts;
  const instruments = activeInstruments(env ?? process.env);
  return Promise.all(instruments.map((inst) => fetchInstrumentCandles(inst, bars, fetchOpts)));
}

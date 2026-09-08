/**
 * Intraday (day trading) részvény-backteszt — a stop/take-profit és a gyertya-méret
 * MÉRÉSE, nem tippelése.
 *
 * A LIVE utat futtatja: ugyanaz a döntés-agy (`planStockCycle`), ugyanaz a végrehajtás
 * (`runStockCycle` → risk-manager + PaperExecutionBroker + egész részvény lot + díj/spread),
 * ugyanazok az ülés-fázisok (nap végi laposra zárás). A különbség csak annyi, hogy a
 * gyertyák történelmiek és a ledger memóriában él.
 *
 * Futtatás:
 *   pnpm tsx scripts/stock-intraday-backtest.ts                 # stop/TP rács, 5m
 *   pnpm tsx scripts/stock-intraday-backtest.ts --tf 15m        # 15 perces gyertyán
 *   pnpm tsx scripts/stock-intraday-backtest.ts --sweep lookback --stop 0.005 --tp 0.01
 *
 * Adat: Yahoo intraday, 60 nap (a szolgáltató maximuma). Az első futás letölti és
 * lemezre menti (`.cache/intraday-<tf>.json`), a továbbiak onnan olvassák.
 */
import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";

config({ path: ".env.local" });
config();
process.env.MARKETS_ENABLE_STOCKS = process.env.MARKETS_ENABLE_STOCKS ?? "1";

import type { OhlcvCandle, Timeframe } from "@/lib/market/candles";
import { TIMEFRAME_MS } from "@/lib/market/candles";
import { activeByClass, type Instrument } from "@/lib/markets/registry";
import { fetchInstrumentCandles } from "@/lib/markets/data";
import {
  runStockCycle,
  intradayPhaseAt,
  STOCK_STRATEGY,
  STOCK_INTRADAY_STRATEGY,
  STOCK_PORTFOLIO_ID,
  STOCK_QUOTE,
} from "@/lib/engine/stock-tick";
import { previousTradingDayKey } from "@/lib/engine/stock-tick";
import { etParts, etDateKey, minutesFromSessionOpen, sessionOpenMs } from "@/lib/markets/calendar";
import { evaluateDayGate, type DayEquityRow } from "@/lib/portfolio/day-equity";
import { fetchEarningsCalendar } from "@/lib/markets/earnings";
import { emptyLedger, cashOf, type LedgerState } from "@/lib/portfolio/ledger";
import { toNumber } from "@/lib/portfolio/money";
import type { StrategyConfig } from "@/lib/strategy/config";
import { ENTRY_SHAPES, type EntryShape } from "@/lib/strategy/intraday-entries";
import { MOMENTUM_RANKINGS, type MomentumRanker } from "@/lib/strategy/momentum-ranking";

const CACHE_DIR = ".cache";
const CAPITAL = 10000;

/**
 * `--nocost`: spread és slippage nullázva. Kontroll-futás — ezzel válik el, hogy egy
 * variáns előnye a JELBŐL jön-e, vagy csak abból, hogy kevesebbet kereskedik.
 */
const NO_COST = process.argv.includes("--nocost");

/**
 * `--fill next-open`: a jel a lezárt gyertyából születik, a KÖTÉS viszont a KÖVETKEZŐ bar
 * NYITÓJÁN történik (audit 2. pont). A mai konvenció ugyanannak a barnak a záróján fillel,
 * vagyis abban a pillanatban köt, amikor a jel elkészül — élesben ez sosem igaz. Ez a
 * kapcsoló méri, mennyit ér a stratégia, ha a végrehajtás egy barral késik.
 */
const NEXT_OPEN_FILL = process.argv.includes("--fill") && arg("fill", "") === "next-open";

/**
 * Széles, likvid univerzum a szélesség-méréshez. Csupa nagy forgalmú, Alpacán
 * `fractionable` amerikai papír és ETF — a momentum-belépő annál több valódi kitörést lát,
 * minél több nevet figyel.
 */
const WIDE_UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "SPY", "QQQ", "AMZN", "GOOGL", "META", "TSLA", "AMD",
  "AVGO", "NFLX", "COST", "JPM", "XOM", "UNH", "LLY", "V", "MA", "HD",
  "INTC", "MU", "PLTR", "COIN", "ORCL", "CRM", "ADBE", "IWM", "SMH", "XLE",
];

/** Instrumentum-leíró egy tetszőleges tickerhez (a backteszt saját univerzumához). */
function stockInstrument(symbol: string): Instrument {
  return {
    symbol,
    assetClass: "stock",
    quote: "USD",
    dataProvider: "yahoo",
    displayName: symbol,
    providerSymbol: symbol,
  };
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadBars(instruments: Instrument[], tf: Timeframe, tag = "core"): Promise<Record<string, OhlcvCandle[]>> {
  const file = path.join(CACHE_DIR, `intraday-${tag}-${tf}.json`);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, OhlcvCandle[]>;
  }
  const out: Record<string, OhlcvCandle[]> = {};
  for (const inst of instruments) {
    const { candles, error } = await fetchInstrumentCandles(inst, 100000, { timeframe: tf });
    if (error) {
      console.error(`  ${inst.symbol}: adat-hiba [${error.code}] ${error.message}`);
      continue;
    }
    out[inst.symbol] = candles;
    console.error(`  ${inst.symbol}: ${candles.length} bar`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/**
 * Időbélyeg-igazítás ELLENŐRZÉSE.
 *
 * A szimuláció minden szimbólumot UGYANAZZAL az indexszel olvas, és a döntés idejét az
 * első szimbólum barjából veszi. Ha bármelyik papírból hiányzik egy bar, az adott papír
 * onnantól ELŐRE csúszik: a jel-bemenete és a fill-ára is a döntés pillanata UTÁNI baré
 * lenne. Ez néma look-ahead volna, ezért inkább leállunk.
 */
function assertAligned(bars: Record<string, OhlcvCandle[]>): void {
  const symbols = Object.keys(bars);
  if (symbols.length < 2) return;
  const n = Math.min(...symbols.map((s) => bars[s].length));
  for (let i = 0; i < n; i++) {
    const t = bars[symbols[0]][i].openTime;
    for (const s of symbols) {
      if (bars[s][i].openTime !== t) {
        throw new Error(
          `Időbélyeg-elcsúszás a(z) ${i}. indexnél: ${symbols[0]}=${new Date(t).toISOString()} ` +
            `vs ${s}=${new Date(bars[s][i].openTime).toISOString()}. A mérés look-ahead lenne, ezért leállt. ` +
            `Töröld a .cache állományt és tölts újra.`,
        );
      }
    }
  }
}

/**
 * A BEFEJEZETLEN utolsó ülés eldobása.
 *
 * Ha a letöltés kereskedési idő közben futott, az utolsó ET-nap csonka. Az ilyen napon
 * nyitott pozíció SOHA nem kap nap végi laposra zárást, hanem a záró egyenlegben
 * piaci áron marad — vagyis kilépési költség nélkül, nem realizált nyereséggel. Ez pont
 * azokat a variánsokat hozza előnybe, amelyek a nap ELEJÉN lépnek be, tehát a
 * napszak-mérést hamisítaná meg.
 */
function dropIncompleteLastSession(bars: Record<string, OhlcvCandle[]>): Record<string, OhlcvCandle[]> {
  const symbols = Object.keys(bars);
  if (symbols.length === 0) return bars;
  const ref = bars[symbols[0]];
  if (ref.length === 0) return bars;
  const lastKey = etDateKey(etParts(ref[ref.length - 1].openTime));
  const lastDay = ref.filter((b) => etDateKey(etParts(b.openTime)) === lastKey);
  // Teljes ülésnek az számít, ahol a záráshoz tapadó bar (15:55 ET, azaz a nyitástól
  // 385 perc) is megvan. A 16:00-s záró print ülésen kívüli, ezért nem számít bele.
  const complete = lastDay.some((b) => (minutesFromSessionOpen(b.openTime) ?? -1) >= 385);
  if (complete) return bars;
  const out: Record<string, OhlcvCandle[]> = {};
  for (const s of symbols) {
    out[s] = bars[s].filter((b) => etDateKey(etParts(b.openTime)) !== lastKey);
  }
  console.error(`  csonka záró ülés eldobva: ${lastKey} (${lastDay.length} bar)`);
  return out;
}

interface RunMetrics {
  label: string;
  finalEquity: number;
  returnPct: number;
  trades: number;
  buys: number;
  winRatePct: number;
  maxDrawdownPct: number;
  eodFlats: number;
  /** Átlagos trade-hozam százalékban (a méret nélküli, tiszta jel-minőség). */
  avgTradePct: number;
  /**
   * A trade-hozamok t-statisztikája (átlag / szórás * sqrt(n)). Durva, de őszinte
   * zaj-mérce: |t| < 2 mellett a variánsok sorrendje NEM megkülönböztethető a véletlentől.
   */
  tStat: number;
}

/** Egy variáns végigjátszása a történelmi barokon. */
async function simulate(
  label: string,
  bars: Record<string, OhlcvCandle[]>,
  instruments: Instrument[],
  strategy: StrategyConfig,
  tf: Timeframe,
  range?: { fromPct: number; toPct: number },
  fractional = false,
  earningsByDate?: Map<string, Set<string>>,
  entryShape?: EntryShape,
  momentumRanking?: MomentumRanker,
): Promise<RunMetrics> {
  const symbols = Object.keys(bars);
  const step = TIMEFRAME_MS[tf];
  const window = Math.max(strategy.momentumLookback, strategy.entryFilterSmaPeriod, strategy.atrPeriod + 1) + 20;
  const total = Math.min(...symbols.map((s) => bars[s].length));
  const start = range ? Math.max(window, Math.floor(total * range.fromPct)) : window;
  const n = range ? Math.floor(total * range.toPct) : total;

  let ledger: LedgerState = emptyLedger(STOCK_PORTFOLIO_ID, "paper", String(CAPITAL), STOCK_QUOTE);
  // NAPI VESZTESÉGKAPU — ugyanaz a TISZTA szabály, amit az éles runner a DB-vel futtat
  // (audit 1. pont). Enélkül a backteszt olyan kötéseket számolna hozamnak, amiket az
  // éles rendszer meg sem kötne.
  let dayRow: DayEquityRow | null = null;
  let peak = CAPITAL;
  let maxDd = 0;
  let buys = 0;
  let sells = 0;
  let wins = 0;
  let eodFlats = 0;
  const entryPrice: Record<string, number> = {};
  const tradeReturns: number[] = [];

  for (let i = start; i < n; i++) {
    const barOpen = bars[symbols[0]][i].openTime;
    const gate = intradayPhaseAt(barOpen + step - 1);
    if (!gate.due) continue;

    const slice: Record<string, OhlcvCandle[]> = {};
    for (const s of symbols) slice[s] = bars[s].slice(i - window, i + 1);
    const entryBlocked = earningsByDate?.get(etDateKey(etParts(barOpen)));

    const equityNow = symbols.reduce((total, s) => {
      const pos = ledger.positions[s];
      return pos ? total + toNumber(pos.qty) * bars[s][i].close : total;
    }, toNumber(cashOf(ledger, STOCK_QUOTE)));

    const res = await runStockCycle({
      tickId: `bt-${i}`,
      now: () => barOpen + step,
      ledger,
      instruments,
      candlesBySymbol: slice,
      timeframe: tf,
      phase: gate.phase,
      strategy,
      fractional,
      entryBlocked,
      entryShape,
      momentumRanking,
      ...(NEXT_OPEN_FILL && i + 1 < n
        ? {
            executionPrices: Object.fromEntries(
              symbols.filter((sy) => bars[sy][i + 1]).map((sy) => [sy, String(bars[sy][i + 1].open)]),
            ),
          }
        : {}),
      resolveDayGate: (equityUsd, nowMs) => {
        const gate = evaluateDayGate({
          nowMs,
          row: dayRow,
          currentEquity: equityUsd,
          thresholdPct: String(strategy.dailyLossCircuitBreakerPct),
          dayKey: etDateKey(etParts(nowMs)),
          dayStartMs: sessionOpenMs(nowMs),
        });
        dayRow = gate.row;
        return { latched: gate.latched, baselineMissing: gate.dayPnlPct === null };
      },
      ...(NO_COST ? { costOverride: { slippageBps: 0, spreadBps: 0, feePct: "0" } } : {}),
      weeklyBudgetRemainingUsd: equityNow * 0.05,
    });
    ledger = res.ledger;

    for (const a of res.actions) {
      if (a.side === "BUY") {
        buys++;
        entryPrice[a.symbol] = a.amountUsd / a.qty;
      } else {
        sells++;
        if (a.kind === "eod-flat") eodFlats++;
        const entry = entryPrice[a.symbol];
        if (entry) {
          const exit = a.amountUsd / a.qty;
          tradeReturns.push(exit / entry - 1);
          if (exit > entry) wins++;
        }
      }
    }

    peak = Math.max(peak, equityNow);
    maxDd = Math.max(maxDd, (peak - equityNow) / peak);
  }

  const finalEquity = symbols.reduce((total, s) => {
    const pos = ledger.positions[s];
    return pos ? total + toNumber(pos.qty) * bars[s][n - 1].close : total;
  }, toNumber(cashOf(ledger, STOCK_QUOTE)));

  const tn = tradeReturns.length;
  const mean = tn > 0 ? tradeReturns.reduce((a, b) => a + b, 0) / tn : 0;
  const variance = tn > 1 ? tradeReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (tn - 1) : 0;
  const sd = Math.sqrt(variance);
  const tStat = tn > 1 && sd > 0 ? (mean / sd) * Math.sqrt(tn) : 0;

  return {
    label,
    finalEquity,
    avgTradePct: mean * 100,
    tStat,
    returnPct: (finalEquity / CAPITAL - 1) * 100,
    trades: sells,
    buys,
    winRatePct: sells > 0 ? (wins / sells) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    eodFlats,
  };
}

/**
 * ET-dátum → az aznap belépő-tiltott szimbólumok. Tiltott, aki AZNAP jelent (bármikor),
 * vagy az ELŐZŐ kereskedési nap ZÁRÁSA UTÁN (amc) jelentett — a reakció ilyenkor a
 * következő napra esik. A naptárat lemezre cache-eljük, hogy a rács ne hívja újra.
 */
async function loadEarnings(symbols: string[], from: string, to: string): Promise<Map<string, Set<string>>> {
  const file = path.join(CACHE_DIR, `earnings-${from}-${to}.json`);
  let entries: { symbol: string; date: string; hour: string }[];
  if (fs.existsSync(file)) {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    entries = await fetchEarningsCalendar(from, to);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries));
  }
  const watched = new Set(symbols.map((s) => s.toUpperCase()));
  const byDate = new Map<string, Set<string>>();
  const add = (date: string, symbol: string) => {
    const set = byDate.get(date) ?? new Set<string>();
    set.add(symbol);
    byDate.set(date, set);
  };
  for (const e of entries) {
    const symbol = e.symbol.toUpperCase();
    if (!watched.has(symbol)) continue;
    add(e.date, symbol);
    if (e.hour === "amc") {
      // A reakció-nap a KÖVETKEZŐ kereskedési nap; a naptárból ezt visszafelé keressük.
      for (let d = 1; d <= 5; d++) {
        const next = new Date(Date.parse(`${e.date}T17:00:00Z`) + d * 86400000);
        const key = etDateKey(etParts(next.getTime()));
        if (previousTradingDayKey(key) === e.date) {
          add(key, symbol);
          break;
        }
      }
    }
  }
  return byDate;
}

async function main() {
  const tf = arg("tf", "5m") as Timeframe;
  const sweep = arg("sweep", "stop-tp");
  const wide = process.argv.includes("--wide");
  const instruments = wide ? WIDE_UNIVERSE.map(stockInstrument) : activeByClass("stock");
  console.error(`Adat betöltése (${tf}, 60 nap, ${instruments.length} instrumentum)…`);
  const bars = dropIncompleteLastSession(await loadBars(instruments, tf, wide ? "wide" : "core"));
  assertAligned(bars);
  const symbols = Object.keys(bars);
  if (symbols.length === 0) {
    console.error("Nincs adat.");
    process.exit(1);
  }
  const first = bars[symbols[0]];
  const from = new Date(first[0].openTime).toISOString().slice(0, 10);
  const to = new Date(first[first.length - 1].openTime).toISOString().slice(0, 10);
  console.error(`${symbols.join(", ")} — ${first.length} bar, ${from} → ${to}\n`);

  const variants: {
    label: string;
    strategy: StrategyConfig;
    fractional?: boolean;
    earnings?: boolean;
    shape?: string;
  }[] = [];
  if (sweep === "stop-tp") {
    for (const stop of [0.003, 0.005, 0.0075, 0.01]) {
      for (const tp of [0.005, 0.0075, 0.01, 0.015]) {
        variants.push({
          label: `stop ${(stop * 100).toFixed(2)}% / TP ${(tp * 100).toFixed(2)}%`,
          strategy: { ...STOCK_STRATEGY, stopLossPct: stop, takeProfitPct: tp },
        });
      }
    }
  } else if (sweep === "lookback") {
    const stop = Number(arg("stop", "0.005"));
    const tp = Number(arg("tp", "0.01"));
    for (const [sma, look] of [
      [12, 24],
      [24, 48],
      [39, 78],
      [78, 156],
    ] as [number, number][]) {
      variants.push({
        label: `SMA ${sma} / lookback ${look}`,
        strategy: {
          ...STOCK_STRATEGY,
          stopLossPct: stop,
          takeProfitPct: tp,
          entryFilterSmaPeriod: sma,
          momentumSmaPeriod: sma,
          momentumLookback: look,
        },
      });
    }
  } else if (sweep === "robust") {
    // Ugyanaz a variáns a 60 nap ELSŐ és MÁSODIK felén — egy szerencsés ablak így kiderül.
    const candidates: [number, number][] = [
      [24, 48],
      [39, 78],
      [78, 156],
    ];
    console.log(`
=== ${tf} · robusztusság (első fél / második fél / teljes) ===`);
    console.log("variáns                         1. fél   2. fél   teljes   trade");
    for (const [sma, look] of candidates) {
      const strategy: StrategyConfig = {
        ...STOCK_STRATEGY,
        entryFilterSmaPeriod: sma,
        momentumSmaPeriod: sma,
        momentumLookback: look,
      };
      const label = `SMA ${sma} / lookback ${look}`;
      const a = await simulate(label, bars, instruments, strategy, tf, { fromPct: 0, toPct: 0.5 });
      const b = await simulate(label, bars, instruments, strategy, tf, { fromPct: 0.5, toPct: 1 });
      const full = await simulate(label, bars, instruments, strategy, tf);
      const fmt = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`.padStart(8);
      console.log(`${label.padEnd(30)}${fmt(a.returnPct)}${fmt(b.returnPct)}${fmt(full.returnPct)}${String(full.trades).padStart(8)}`);
    }
    return;
  } else if (sweep === "shape") {
    // A BELÉPŐ ALAKJA — a stratégia-tér valódi kérdése. Minden alak UGYANAZT a kockázati
    // keretet, méretezést, stopot és nap végi zárást kapja; csak a belépő jele más.
    // Mindegyik a 60 nap MINDKÉT felén külön is mérve (a szerencsés ablak így kiderül).
    const only = arg("shape", "");
    const names = only ? only.split(",") : Object.keys(ENTRY_SHAPES);
    const rows: { label: string; a: number; b: number; full: RunMetrics }[] = [];
    for (const name of names) {
      if (!ENTRY_SHAPES[name]) {
        console.error(`  ismeretlen alak: ${name}`);
        continue;
      }
      const shape = ENTRY_SHAPES[name];
      // A jel-ablakok BAR-ban értendők, ezért más gyertya-méreten át kell skálázni
      // (5m: 78 bar = 1 ülés; 1m: 390 bar = 1 ülés).
      const smaArg = Number(arg('sma', '0'));
      const lookArg = Number(arg('look', '0'));
      const st: StrategyConfig = smaArg > 0 && lookArg > 0
        ? { ...STOCK_INTRADAY_STRATEGY, entryFilterSmaPeriod: smaArg, momentumSmaPeriod: smaArg, momentumLookback: lookArg }
        : STOCK_INTRADAY_STRATEGY;
      const frac = process.argv.includes('--fractional');
      const a = await simulate(name, bars, instruments, st, tf, { fromPct: 0, toPct: 0.5 }, frac, undefined, shape);
      const b = await simulate(name, bars, instruments, st, tf, { fromPct: 0.5, toPct: 1 }, frac, undefined, shape);
      const full = await simulate(name, bars, instruments, st, tf, undefined, frac, undefined, shape);
      rows.push({ label: name, a: a.returnPct, b: b.returnPct, full });
      console.error(
        `  ${name.padEnd(14)} teljes ${full.returnPct >= 0 ? "+" : ""}${full.returnPct.toFixed(2)}%  ` +
          `trade ${String(full.trades).padStart(4)}  win ${full.winRatePct.toFixed(0)}%  maxDD ${full.maxDrawdownPct.toFixed(2)}%`,
      );
    }
    rows.sort((x, y) => y.full.returnPct - x.full.returnPct);
    const fmt = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`.padStart(9);
    console.log(`\n=== ${tf} · belépő-alak · 60 nap · ${symbols.join("/")}${NO_COST ? " · KÖLTSÉG NÉLKÜL" : ""} ===`);
    console.log("alak            1. fél    2. fél    teljes   trade  win%   maxDD%   átlag/trade      t  robusztus");
    for (const r of rows) {
      const robust = r.a > 0 && r.b > 0 ? "IGEN" : "nem";
      console.log(
        `${r.label.padEnd(14)}${fmt(r.a)}${fmt(r.b)}${fmt(r.full.returnPct)}` +
          `${String(r.full.trades).padStart(8)}${r.full.winRatePct.toFixed(0).padStart(6)}%` +
          `${r.full.maxDrawdownPct.toFixed(2).padStart(8)}%${r.full.avgTradePct.toFixed(3).padStart(11)}%` +
          `${r.full.tStat.toFixed(2).padStart(7)}   ${robust}`,
      );
    }
    return;
  } else if (sweep === "ranking") {
    // MOMENTUM-RANGSOR: ha több papír is kitörésben van, melyiket vesszük meg. A mai
    // rangsor a nyers százalék-maximum; széles univerzumon ez SZISZTEMATIKUSAN a
    // legvolatilisebb nevet hozza (a legnagyobb kilengés mindig egy zajos papíré), ami a
    // 2026-09-08-i szélesség-mérés bukását is magyarázhatja. Ugyanaz a jel, ugyanaz a
    // kockázati keret, ugyanaz a végrehajtás — CSAK a kiválasztás más.
    const only = arg("ranking", "");
    const names = only ? only.split(",") : Object.keys(MOMENTUM_RANKINGS);
    const shapeName = arg("shape", "");
    const shape = shapeName ? ENTRY_SHAPES[shapeName] : undefined;
    if (shapeName !== "" && !shape) {
      console.error(`ismeretlen alak: ${shapeName}`);
      process.exit(1);
    }
    // A szélesség-mérés rácsa (tétel-méret / egyidejű pozíció), hogy a számok az ottani
    // sorokkal összevethetők legyenek. Tört lottal, különben a kis tétel nullára kerekül.
    const grid: [number, number][] = [
      [0.1, 3],
      [0.05, 6],
      [0.03, 10],
    ];
    const rows: { label: string; a: number; b: number; full: RunMetrics }[] = [];
    for (const name of names) {
      const rank = MOMENTUM_RANKINGS[name];
      if (!rank) {
        console.error(`  ismeretlen rangsor: ${name}`);
        continue;
      }
      for (const [pct, conc] of grid) {
        const st: StrategyConfig = {
          ...STOCK_INTRADAY_STRATEGY,
          momentumBuyPct: pct,
          maxConcurrentPositions: conc,
        };
        const label = `${name} · ${(pct * 100).toFixed(0)}% · ${conc} poz`;
        const a = await simulate(label, bars, instruments, st, tf, { fromPct: 0, toPct: 0.5 }, true, undefined, shape, rank);
        const b = await simulate(label, bars, instruments, st, tf, { fromPct: 0.5, toPct: 1 }, true, undefined, shape, rank);
        const full = await simulate(label, bars, instruments, st, tf, undefined, true, undefined, shape, rank);
        rows.push({ label, a: a.returnPct, b: b.returnPct, full });
        console.error(
          `  ${label.padEnd(28)} teljes ${full.returnPct >= 0 ? "+" : ""}${full.returnPct.toFixed(2)}%  ` +
            `trade ${String(full.trades).padStart(4)}  win ${full.winRatePct.toFixed(0)}%  maxDD ${full.maxDrawdownPct.toFixed(2)}%`,
        );
      }
    }
    rows.sort((x, y) => y.full.returnPct - x.full.returnPct);
    const fmt = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`.padStart(9);
    console.log(
      `
=== ${tf} · momentum-rangsor · 60 nap · ${symbols.length} papír${NEXT_OPEN_FILL ? " · KÖVETKEZŐ NYITÓN FILLELVE" : ""}` +
        `${shapeName ? ` · alak: ${shapeName}` : " · alak: built-in"}${NO_COST ? " · KÖLTSÉG NÉLKÜL" : ""} ===`,
    );
    console.log("rangsor · tétel · poz         1. fél    2. fél    teljes   trade  win%   maxDD%   átlag/trade      t  robusztus");
    for (const r of rows) {
      const robust = r.a > 0 && r.b > 0 ? "IGEN" : "nem";
      console.log(
        `${r.label.padEnd(28)}${fmt(r.a)}${fmt(r.b)}${fmt(r.full.returnPct)}` +
          `${String(r.full.trades).padStart(8)}${r.full.winRatePct.toFixed(0).padStart(6)}%` +
          `${r.full.maxDrawdownPct.toFixed(2).padStart(8)}%${r.full.avgTradePct.toFixed(3).padStart(11)}%` +
          `${r.full.tStat.toFixed(2).padStart(7)}   ${robust}`,
      );
    }
    return;
  } else if (sweep === "earnings") {
    // Gyorsjelentés-tiltás hatása: ugyanaz a stratégia, csak a jelentő papírba aznap
    // nincs ÚJ belépő. A naptár a Finnhubról jön, a mért ablakra.
    variants.push({ label: "tiltás NÉLKÜL", strategy: STOCK_INTRADAY_STRATEGY });
    variants.push({ label: "earnings-napon nincs belépő", strategy: STOCK_INTRADAY_STRATEGY, earnings: true });
  } else if (sweep === "breadth") {
    // Szélesség: ugyanaz a jel, több papíron. Tört lottal, hogy a kis tétel se
    // kerekedjen nullára a drága neveken.
    for (const [pct, conc] of [
      [0.1, 3],
      [0.1, 6],
      [0.05, 6],
      [0.05, 10],
      [0.03, 10],
    ] as [number, number][]) {
      variants.push({
        label: `tört · ${(pct * 100).toFixed(0)}% · ${conc} poz`,
        strategy: { ...STOCK_INTRADAY_STRATEGY, momentumBuyPct: pct, maxConcurrentPositions: conc },
        fractional: true,
      });
    }
  } else if (sweep === "sizing") {
    // Tört részvény (Alpaca `fractionable`) vs egész lot, és a tétel-méret hatása.
    // Egész lotnál a kis tétel a drága papírokon 0 darabra kerekül — ezt méri a rács.
    variants.push({ label: "egész lot · 10% · 3 poz", strategy: STOCK_INTRADAY_STRATEGY });
    for (const [pct, conc] of [
      [0.02, 4],
      [0.05, 4],
      [0.1, 3],
      [0.1, 4],
      [0.15, 4],
      [0.2, 4],
    ] as [number, number][]) {
      variants.push({
        label: `tört · ${(pct * 100).toFixed(0)}% · ${conc} poz`,
        strategy: { ...STOCK_INTRADAY_STRATEGY, momentumBuyPct: pct, maxConcurrentPositions: conc },
        fractional: true,
      });
    }
  } else if (sweep === "stopmode") {
    // A kilépés ALAKJA: fix széles stop (gyakorlatilag csak EOD-zárás) vs ATR-trailing,
    // ami a napon belül utánahúz és a nyereséget be is zárhatja.
    variants.push({ label: "fix 5% stop / TP 10%", strategy: STOCK_STRATEGY });
    for (const mult of [1, 1.5, 2, 3]) {
      variants.push({
        label: `ATR-trailing x${mult} / TP 10%`,
        strategy: { ...STOCK_STRATEGY, stopMode: "atr", atrMult: mult },
      });
      variants.push({
        label: `ATR-trailing x${mult} / TP 1,5%`,
        strategy: { ...STOCK_STRATEGY, stopMode: "atr", atrMult: mult, takeProfitPct: 0.015 },
      });
    }
  } else {
    variants.push({ label: "napi swing default (5%/10%)", strategy: STOCK_STRATEGY });
  }

  // Gyorsjelentés-naptár, ha valamelyik variáns kéri (ET-dátum → tiltott szimbólumok).
  let earningsByDate: Map<string, Set<string>> | undefined;
  if (variants.some((v) => v.earnings)) {
    earningsByDate = await loadEarnings(symbols, from, to);
    console.error(`gyorsjelentés-napok az ablakban: ${earningsByDate.size}
`);
  }

  const results: RunMetrics[] = [];
  for (const v of variants) {
    const m = await simulate(
      v.label,
      bars,
      instruments,
      v.strategy,
      tf,
      undefined,
      v.fractional === true,
      v.earnings ? earningsByDate : undefined,
      v.shape ? ENTRY_SHAPES[v.shape] : undefined,
    );
    results.push(m);
    console.error(
      `  ${m.label.padEnd(30)} ${m.returnPct >= 0 ? "+" : ""}${m.returnPct.toFixed(2)}%  ` +
        `trade ${String(m.trades).padStart(4)}  win ${m.winRatePct.toFixed(0)}%  maxDD ${m.maxDrawdownPct.toFixed(2)}%`,
    );
  }

  results.sort((a, b) => b.returnPct - a.returnPct);
  console.log(`\n=== ${tf} · ${sweep} · 60 nap · ${symbols.join("/")} ===`);
  console.log("variáns                        hozam%   trade  vétel  win%   maxDD%  EOD-zárás");
  for (const m of results) {
    const ret = `${m.returnPct >= 0 ? "+" : ""}${m.returnPct.toFixed(2)}%`;
    console.log(
      `${m.label.padEnd(30)} ${ret.padStart(8)}${String(m.trades).padStart(8)}${String(m.buys).padStart(7)}` +
        `${m.winRatePct.toFixed(0).padStart(6)}%${m.maxDrawdownPct.toFixed(2).padStart(8)}%${String(m.eodFlats).padStart(9)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

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
  STOCK_PORTFOLIO_ID,
  STOCK_QUOTE,
} from "@/lib/engine/stock-tick";
import { emptyLedger, cashOf, type LedgerState } from "@/lib/portfolio/ledger";
import { toNumber } from "@/lib/portfolio/money";
import type { StrategyConfig } from "@/lib/strategy/config";

const CACHE_DIR = ".cache";
const CAPITAL = 10000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadBars(instruments: Instrument[], tf: Timeframe): Promise<Record<string, OhlcvCandle[]>> {
  const file = path.join(CACHE_DIR, `intraday-${tf}.json`);
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

interface RunMetrics {
  label: string;
  finalEquity: number;
  returnPct: number;
  trades: number;
  buys: number;
  winRatePct: number;
  maxDrawdownPct: number;
  eodFlats: number;
}

/** Egy variáns végigjátszása a történelmi barokon. */
async function simulate(
  label: string,
  bars: Record<string, OhlcvCandle[]>,
  instruments: Instrument[],
  strategy: StrategyConfig,
  tf: Timeframe,
  range?: { fromPct: number; toPct: number },
): Promise<RunMetrics> {
  const symbols = Object.keys(bars);
  const step = TIMEFRAME_MS[tf];
  const window = Math.max(strategy.momentumLookback, strategy.entryFilterSmaPeriod, strategy.atrPeriod + 1) + 20;
  const total = Math.min(...symbols.map((s) => bars[s].length));
  const start = range ? Math.max(window, Math.floor(total * range.fromPct)) : window;
  const n = range ? Math.floor(total * range.toPct) : total;

  let ledger: LedgerState = emptyLedger(STOCK_PORTFOLIO_ID, "paper", String(CAPITAL), STOCK_QUOTE);
  let peak = CAPITAL;
  let maxDd = 0;
  let buys = 0;
  let sells = 0;
  let wins = 0;
  let eodFlats = 0;
  const entryPrice: Record<string, number> = {};

  for (let i = start; i < n; i++) {
    const barOpen = bars[symbols[0]][i].openTime;
    const gate = intradayPhaseAt(barOpen + step - 1);
    if (!gate.due) continue;

    const slice: Record<string, OhlcvCandle[]> = {};
    for (const s of symbols) slice[s] = bars[s].slice(i - window, i + 1);

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
        if (entry && a.amountUsd / a.qty > entry) wins++;
      }
    }

    peak = Math.max(peak, equityNow);
    maxDd = Math.max(maxDd, (peak - equityNow) / peak);
  }

  const finalEquity = symbols.reduce((total, s) => {
    const pos = ledger.positions[s];
    return pos ? total + toNumber(pos.qty) * bars[s][n - 1].close : total;
  }, toNumber(cashOf(ledger, STOCK_QUOTE)));

  return {
    label,
    finalEquity,
    returnPct: (finalEquity / CAPITAL - 1) * 100,
    trades: sells,
    buys,
    winRatePct: sells > 0 ? (wins / sells) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    eodFlats,
  };
}

async function main() {
  const tf = arg("tf", "5m") as Timeframe;
  const sweep = arg("sweep", "stop-tp");
  const instruments = activeByClass("stock");
  console.error(`Adat betöltése (${tf}, 60 nap, ${instruments.length} instrumentum)…`);
  const bars = await loadBars(instruments, tf);
  const symbols = Object.keys(bars);
  if (symbols.length === 0) {
    console.error("Nincs adat.");
    process.exit(1);
  }
  const first = bars[symbols[0]];
  const from = new Date(first[0].openTime).toISOString().slice(0, 10);
  const to = new Date(first[first.length - 1].openTime).toISOString().slice(0, 10);
  console.error(`${symbols.join(", ")} — ${first.length} bar, ${from} → ${to}\n`);

  const variants: { label: string; strategy: StrategyConfig }[] = [];
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

  const results: RunMetrics[] = [];
  for (const v of variants) {
    const m = await simulate(v.label, bars, instruments, v.strategy, tf);
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

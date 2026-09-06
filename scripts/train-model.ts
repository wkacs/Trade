/**
 * ML modell tréning (T13) — TS-natív logisztikus regresszió a Binance történelmi
 * gyertyáin, a PRODUKCIÓS feature-építést újrahasználva.
 *
 * Futtatás: pnpm tsx scripts/train-model.ts
 * Kimenet:  src/lib/ml/model.candidate.json
 *
 * FONTOS (T13): a tréning SOHA nem írja felül az aktív `model.json`-t. Az új modell
 * JELÖLT, és a léptetés külön, tudatos döntés — az AUC ≥ 0,5 önmagában nem kapu, az
 * csak a véletlen szintje. A jelölt promóciós értékelését az `evaluatePromotion` végzi.
 *
 * A tréning ugyanazt a lezárt-gyertya pipeline-t használja, mint a futó rendszer
 * (`normalizeBinanceKlines` + `buildFeaturesFromCandles`), és a kimenetbe beírja a
 * feature-verziót, hogy inkompatibilis modell ne kerülhessen élesbe észrevétlenül.
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import {
  buildFeaturesFromCandles,
  featureVector,
  featureWarmupBars,
  FEATURE_NAMES,
  FEATURE_VERSION,
  DEFAULT_FEATURE_CONFIG,
} from "@/lib/ml/features";
import { evaluatePromotion } from "@/lib/ml/predictor";
import { normalizeBinanceKlines, mergeCandles, type OhlcvCandle } from "@/lib/market/candles";
import { COIN_UNIVERSE } from "@/lib/config";

const INTERVAL = "1h" as const;
const HOUR_MS = 3_600_000;
const PAGES = 5; // 5 × 1000 ≈ 5000 óra ≈ 208 nap / coin
const CANDIDATE_PATH = "src/lib/ml/model.candidate.json";
const ACTIVE_PATH = "src/lib/ml/model.json";

async function fetchHistory(sym: string, nowMs: number): Promise<OhlcvCandle[]> {
  const pages: OhlcvCandle[][] = [];
  let endTime: number | undefined;
  for (let p = 0; p < PAGES; p++) {
    const u = `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${INTERVAL}&limit=1000${
      endTime ? `&endTime=${endTime}` : ""
    }`;
    const res = await fetch(u);
    if (!res.ok) {
      console.error(`[${sym}] HTTP ${res.status} — az adatsor HIÁNYOS, a tréning ezzel a korláttal fut.`);
      break;
    }
    const k = (await res.json()) as unknown[][];
    if (!k.length) break;
    // UGYANAZ a normalizálás, mint élesben: a futó gyertya kiesik, a duplikátum is.
    pages.push(normalizeBinanceKlines(k, sym, INTERVAL, nowMs).candles);
    endTime = Number(k[0][0]) - 1;
  }
  return mergeCandles(pages);
}

/**
 * Finanszírozási ráta TÖRTÉNET (8 óránként publikálva). Óránkénti sorozattá az UTOLSÓ
 * érvényes érték tartásával válik: a funding 8 órán át valóban az az érték marad.
 */
async function fetchFundingHistory(sym: string, fromMs: number): Promise<{ t: number; pct: number }[]> {
  const out: { t: number; pct: number }[] = [];
  let startTime = fromMs;
  for (let page = 0; page < 20; page++) {
    const u = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}USDT&startTime=${startTime}&limit=1000`;
    const res = await fetch(u);
    if (!res.ok) {
      console.error(`[${sym}] funding HTTP ${res.status} — a kontextus HIÁNYOS.`);
      break;
    }
    const rows = (await res.json()) as { fundingTime: number; fundingRate: string }[];
    if (!rows.length) break;
    for (const r of rows) out.push({ t: Number(r.fundingTime), pct: Number(r.fundingRate) * 100 });
    const lastT = Number(rows[rows.length - 1].fundingTime);
    if (rows.length < 1000 || lastT <= startTime) break;
    startTime = lastT + 1;
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Coinbase (USD) órás záróárak — a prémium referenciája. Lapoz, 300-as kötegekben. */
async function fetchCoinbaseCloses(sym: string, fromMs: number, toMs: number): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  let end = toMs;
  for (let page = 0; page < 40 && end > fromMs; page++) {
    const start = Math.max(fromMs, end - 300 * HOUR_MS);
    const u =
      `https://api.exchange.coinbase.com/products/${sym}-USD/candles` +
      `?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const res = await fetch(u, { headers: { "User-Agent": "ai-crypto-trader/train" } });
    if (!res.ok) {
      console.error(`[${sym}] coinbase HTTP ${res.status} — a prémium-kontextus HIÁNYOS.`);
      break;
    }
    // [ time(s), low, high, open, close, volume ]
    const rows = (await res.json()) as number[][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) map.set(Math.floor((r[0] * 1000) / HOUR_MS) * HOUR_MS, r[4]);
    end = start;
    await new Promise((r) => setTimeout(r, 120)); // publikus rate limit
  }
  return map;
}

/** Az utolsó érvényes funding-érték egy időpontban (nincs jövőbe nézés). */
function fundingAt(history: { t: number; pct: number }[], atMs: number): number | null {
  let lo = 0;
  let hi = history.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].t <= atMs) {
      best = history[mid].pct;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

interface Sample {
  x: number[];
  y: number;
  t: number;
}

/**
 * A minta a PRODUKCIÓS feature-építésből jön — nincs tréning/futás eltérés.
 *
 * Az f3 készlet áron kívüli kontextust is kér (funding, prémium). Ha egy órára nincs
 * kontextus, a minta KIMARAD — kitalált nullával nem tanítunk.
 */
function buildSamples(
  candles: OhlcvCandle[],
  funding: { t: number; pct: number }[],
  coinbaseCloses: Map<number, number>,
): { samples: Sample[]; skippedNoContext: number } {
  const warmup = featureWarmupBars(DEFAULT_FEATURE_CONFIG);
  const out: Sample[] = [];
  let skippedNoContext = 0;
  for (let i = warmup - 1; i < candles.length - 1; i++) {
    const window = candles.slice(Math.max(0, i - 100), i + 1);
    const bar = candles[i];
    const hourKey = Math.floor(bar.openTime / HOUR_MS) * HOUR_MS;
    const cb = coinbaseCloses.get(hourKey);
    const fundingPct = fundingAt(funding, bar.closeTime);
    const premiumPct = cb !== undefined && bar.close > 0 ? ((cb - bar.close) / bar.close) * 100 : null;
    if (fundingPct === null || premiumPct === null) {
      skippedNoContext++;
      continue;
    }
    const r = buildFeaturesFromCandles(window, DEFAULT_FEATURE_CONFIG, { fundingRatePct: fundingPct, premiumPct });
    if (!r.features) continue;
    const x = featureVector(r.features);
    if (x.some((v) => !Number.isFinite(v))) continue;
    out.push({ x, y: candles[i + 1].close > candles[i].close ? 1 : 0, t: candles[i].closeTime });
  }
  return { samples: out, skippedNoContext };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

function standardize(rows: number[][]) {
  const n = rows.length;
  const d = rows[0].length;
  const mean = Array(d).fill(0);
  const std = Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j] / n;
  for (const r of rows) for (let j = 0; j < d; j++) std[j] += (r[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  return { mean, std };
}
const apply = (x: number[], mean: number[], std: number[]) => x.map((v, j) => (v - mean[j]) / std[j]);

function train(X: number[][], y: number[], lr = 0.3, l2 = 1e-3, iters = 4000) {
  const n = X.length;
  const d = X[0].length;
  const w = Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const err = sigmoid(dot(w, X[i]) + b) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}

function metrics(X: number[][], y: number[], w: number[], b: number) {
  const p = X.map((x) => sigmoid(dot(w, x) + b));
  const acc = y.reduce((s, yi, i) => s + ((p[i] >= 0.5 ? 1 : 0) === yi ? 1 : 0), 0) / y.length;
  const idx = p.map((_, i) => i).sort((a, c) => p[a] - p[c]);
  let rankSum = 0;
  idx.forEach((i, r) => {
    if (y[i] === 1) rankSum += r + 1;
  });
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  const auc = pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
  return { acc, auc, base: pos / y.length, n: y.length };
}

async function main() {
  const now = Date.now();
  const trainS: Sample[] = [];
  const testS: Sample[] = [];
  for (const sym of COIN_UNIVERSE) {
    const candles = await fetchHistory(sym, now);
    if (candles.length === 0) {
      console.error(`[${sym}] nincs gyertya — kihagyva.`);
      continue;
    }
    const fromMs = candles[0].openTime;
    const [funding, coinbase] = await Promise.all([
      fetchFundingHistory(sym, fromMs),
      fetchCoinbaseCloses(sym, fromMs, now),
    ]);
    const { samples: s, skippedNoContext } = buildSamples(candles, funding, coinbase);
    const cut = Math.floor(s.length * 0.8); // idő-alapú: első 80% tréning, utolsó 20% teszt
    trainS.push(...s.slice(0, cut));
    testS.push(...s.slice(cut));
    console.log(
      `${sym}: ${candles.length} gyertya · funding ${funding.length} · coinbase ${coinbase.size} óra ` +
        `→ ${s.length} minta (train ${cut}, test ${s.length - cut}); kontextus hiánya miatt kimaradt: ${skippedNoContext}`,
    );
  }

  if (trainS.length === 0 || testS.length === 0) {
    console.error("❌ Nincs elég minta a tréninghez.");
    process.exit(1);
    return;
  }

  const { mean, std } = standardize(trainS.map((s) => s.x));
  const Xtr = trainS.map((s) => apply(s.x, mean, std));
  const ytr = trainS.map((s) => s.y);
  const Xte = testS.map((s) => apply(s.x, mean, std));
  const yte = testS.map((s) => s.y);

  const { w, b } = train(Xtr, ytr);
  const tr = metrics(Xtr, ytr, w, b);
  const te = metrics(Xte, yte, w, b);

  console.log(`\n📊 TRAIN: acc=${(tr.acc * 100).toFixed(1)}%  auc=${tr.auc.toFixed(3)}  base(up)=${(tr.base * 100).toFixed(1)}%  n=${tr.n}`);
  console.log(`📊 TEST : acc=${(te.acc * 100).toFixed(1)}%  auc=${te.auc.toFixed(3)}  base(up)=${(te.base * 100).toFixed(1)}%  n=${te.n}`);
  console.log("   (TEST a legfrissebb 20% — ez a valódi out-of-sample jelzés)");

  const candidate = {
    type: "logreg",
    features: [...FEATURE_NAMES],
    featureVersion: FEATURE_VERSION,
    weights: w,
    bias: b,
    mean,
    std,
    trainedAtMs: now,
    samples: { train: tr.n, test: te.n },
    metrics: { trainAcc: tr.acc, testAcc: te.acc, testAuc: te.auc, testBaseUp: te.base },
  };
  writeFileSync(CANDIDATE_PATH, JSON.stringify(candidate, null, 2));
  console.log(`\n✅ JELÖLT mentve: ${CANDIDATE_PATH} (az aktív ${ACTIVE_PATH} ÉRINTETLEN)`);

  const active = existsSync(ACTIVE_PATH) ? JSON.parse(readFileSync(ACTIVE_PATH, "utf8")) : {};
  const gate = evaluatePromotion(candidate, active);
  if (gate.promote) {
    console.log("\n🟢 A jelölt megfelel a promóciós feltételeknek. A LÉPTETÉS KÜLÖN, KÉZI DÖNTÉS:");
    console.log(`   cp ${CANDIDATE_PATH} ${ACTIVE_PATH}`);
  } else {
    console.log("\n🔴 A jelölt NEM léptethető:");
    for (const r of gate.reasons) console.log(`   - ${r}`);
  }
}

main().catch((e) => {
  console.error("❌", e?.message ?? e);
  process.exit(1);
});

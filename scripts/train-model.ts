/**
 * ML modell tréning — TS-natív logisztikus regresszió a Binance történelmi
 * gyertyáin, a PRODUKCIÓS buildFeatures-t újrahasználva (tréning=inferencia konzisztens).
 *
 * Futtatás: pnpm tsx scripts/train-model.ts
 * Kimenet:  src/lib/ml/model.json (a predictor.ts ezt tölti be)
 *
 * Cél: a next-hour irány (up/down) előrejelzése a return1h/return4h/volatility4h/
 * volumeRatio feature-ökből. Idő-alapú train/test split (a teszt a legfrissebb adat).
 */
import { writeFileSync } from "fs";
import { buildFeatures } from "@/lib/ml/features";
import { COIN_UNIVERSE } from "@/lib/config";
import type { DataPoint } from "@/lib/types";

const INTERVAL = "1h";
const PAGES = 5; // 5 × 1000 ≈ 5000 óra ≈ 208 nap / coin
const WINDOW = 24; // ugyanannyi gyertya, mint amit a BinanceOHLCCollector éles módban gyűjt
const FEATURES = ["return1h", "return4h", "volatility4h", "volumeRatio"] as const;

interface Candle { t: number; close: number; volume: number; open: number; }

async function fetchHistory(sym: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined = undefined;
  for (let p = 0; p < PAGES; p++) {
    const u = `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${INTERVAL}&limit=1000${endTime ? `&endTime=${endTime}` : ""}`;
    const res = await fetch(u);
    if (!res.ok) { console.error(`[${sym}] HTTP ${res.status}`); break; }
    const k = (await res.json()) as unknown[][];
    if (!k.length) break;
    const page = k.map((c) => ({ t: Number(c[6]), close: Number(c[4]), volume: Number(c[5]), open: Number(c[1]) }));
    out.push(...page);
    endTime = Number(k[0][0]) - 1; // a legkorábbi gyertya openTime-ja elé
  }
  // időrend + dedup
  const seen = new Set<number>();
  return out.filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true))).sort((a, b) => a.t - b.t);
}

function candlesToPoints(sym: string, cs: Candle[]): DataPoint[] {
  return cs.map((c) => ({
    source: "binance", symbol: sym, timestamp: c.t, kind: "price",
    price: { usd: c.close, volume24h: c.volume, change24hPct: c.open ? ((c.close - c.open) / c.open) * 100 : 0 },
  }));
}

interface Sample { x: number[]; y: number; t: number; }

function buildSamples(sym: string, cs: Candle[]): Sample[] {
  const pts = candlesToPoints(sym, cs);
  const s: Sample[] = [];
  for (let i = WINDOW - 1; i < cs.length - 1; i++) {
    const win = pts.slice(i - WINDOW + 1, i + 1);
    const f = buildFeatures(win)[0];
    if (!f) continue;
    const x = [f.return1h, f.return4h, f.volatility4h, f.volumeRatio];
    if (x.some((v) => !Number.isFinite(v))) continue;
    s.push({ x, y: cs[i + 1].close > cs[i].close ? 1 : 0, t: cs[i].t });
  }
  return s;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

function standardize(rows: number[][]) {
  const n = rows.length, d = rows[0].length;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j] / n;
  for (const r of rows) for (let j = 0; j < d; j++) std[j] += (r[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  return { mean, std };
}
const apply = (x: number[], mean: number[], std: number[]) => x.map((v, j) => (v - mean[j]) / std[j]);

function train(X: number[][], y: number[], lr = 0.3, l2 = 1e-3, iters = 4000) {
  const n = X.length, d = X[0].length;
  let w = Array(d).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
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
  // AUC (rank-alapú)
  const idx = p.map((_, i) => i).sort((a, c) => p[a] - p[c]);
  let rankSum = 0; idx.forEach((i, r) => { if (y[i] === 1) rankSum += r + 1; });
  const pos = y.filter((v) => v === 1).length, neg = y.length - pos;
  const auc = pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
  const base = pos / y.length;
  return { acc, auc, base, n: y.length };
}

async function main() {
  let trainS: Sample[] = [], testS: Sample[] = [];
  for (const sym of COIN_UNIVERSE) {
    const cs = await fetchHistory(sym);
    const s = buildSamples(sym, cs);
    const cut = Math.floor(s.length * 0.8); // idő-alapú: első 80% tréning, utolsó 20% teszt
    trainS.push(...s.slice(0, cut));
    testS.push(...s.slice(cut));
    console.log(`${sym}: ${cs.length} gyertya → ${s.length} minta (train ${cut}, test ${s.length - cut})`);
  }

  const { mean, std } = standardize(trainS.map((s) => s.x));
  const Xtr = trainS.map((s) => apply(s.x, mean, std)), ytr = trainS.map((s) => s.y);
  const Xte = testS.map((s) => apply(s.x, mean, std)), yte = testS.map((s) => s.y);

  const { w, b } = train(Xtr, ytr);
  const tr = metrics(Xtr, ytr, w, b), te = metrics(Xte, yte, w, b);

  console.log(`\n📊 TRAIN: acc=${(tr.acc * 100).toFixed(1)}%  auc=${tr.auc.toFixed(3)}  base(up)=${(tr.base * 100).toFixed(1)}%  n=${tr.n}`);
  console.log(`📊 TEST : acc=${(te.acc * 100).toFixed(1)}%  auc=${te.auc.toFixed(3)}  base(up)=${(te.base * 100).toFixed(1)}%  n=${te.n}`);
  console.log(`   (TEST a legfrissebb 20% — ez a valódi out-of-sample jelzés)`);

  const model = {
    type: "logreg", features: FEATURES, weights: w, bias: b, mean, std,
    trainedAtMs: TRAINED_AT, samples: { train: tr.n, test: te.n },
    metrics: { trainAcc: tr.acc, testAcc: te.acc, testAuc: te.auc, testBaseUp: te.base },
  };
  writeFileSync("src/lib/ml/model.json", JSON.stringify(model, null, 2));
  console.log("\n✅ Mentve: src/lib/ml/model.json");
}

// Date.now() egyszer, a tetején (a tréning determinisztikusabb logolásához)
const TRAINED_AT = Date.now();
main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });

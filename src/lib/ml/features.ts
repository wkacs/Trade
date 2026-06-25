import type { DataPoint } from "@/lib/types";

/**
 * Feature engineering a LightGBM modellhez — árváltozás, volatilitás,
 * volume-jelölők az elmúlt N órából. Lásd spec §3.2 (ML komponens).
 * A tréning külső Python scripttel történik (lásd ml/README.md).
 */
export interface MlFeatures {
  symbol: string;
  return1h: number;
  return4h: number;
  volatility4h: number;
  volumeRatio: number; // jelenlegi volume / átlag
}

export function buildFeatures(prices: DataPoint[], windowHours = 4): MlFeatures[] {
  // Csoportosítás symbolonként, majd ablakolt return/volatilitás számítás.
  const bySymbol = new Map<string, DataPoint[]>();
  for (const p of prices) {
    if (p.kind !== "price" || !p.price) continue;
    const arr = bySymbol.get(p.symbol) ?? [];
    arr.push(p);
    bySymbol.set(p.symbol, arr);
  }
  const out: MlFeatures[] = [];
  const symbols = Array.from(bySymbol.keys());
  for (const symbol of symbols) {
    const arr = bySymbol.get(symbol)!;
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, b) => a.timestamp - b.timestamp);
    const px = sorted.map((p) => p.price!.usd);
    const last = px[px.length - 1];
    const prev1h = px[px.length - 2] ?? last;
    const prev4h = px[Math.max(0, px.length - 1 - windowHours)] ?? last;
    const returns = px.slice(1).map((p, i) => (p - px[i]) / px[i]);
    const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    const variance =
      returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length || 1);
    out.push({
      symbol,
      return1h: (last - prev1h) / prev1h,
      return4h: (last - prev4h) / prev4h,
      volatility4h: Math.sqrt(variance),
      volumeRatio: 1, // egyszerűsített; a tényleges átlag-történetből számolandó
    });
  }
  return out;
}

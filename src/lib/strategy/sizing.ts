/**
 * Belépő-méretező. Kockázat-alapú (fix-frakciós kockázat) fix stop módban: a pozíció
 * akkora, hogy a stopig vett veszteség a tőke riskPerTradePct-je legyen. Fix stopnál a
 * stop-távolság = stopLossPct, ezért a méret ÁR-FÜGGETLEN. atr módban / riskPerTradePct=0
 * esetén a régi flat méret (equity*flatPct). Tiszta függvény.
 */
export interface SizeEntryParams {
  riskPerTradePct: number;
  stopLossPct: number;
  stopMode: "fixed" | "atr";
  maxPositionPct: number;
  flatPct: number;
}

export function sizeEntry(equity: number, p: SizeEntryParams): number {
  const riskOk = p.riskPerTradePct > 0 && p.stopMode === "fixed" && p.stopLossPct > 0;
  if (!riskOk) return equity * p.flatPct;
  const raw = (p.riskPerTradePct * equity) / p.stopLossPct;
  return Math.min(raw, p.maxPositionPct * equity);
}

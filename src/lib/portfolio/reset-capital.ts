/** Forint keret átváltása a ledger USDT/USD quote pénznemére, 8 tizedes pontossággal. */
export function quoteCapitalFromHuf(huf: number, hufPerUsd: number): string {
  if (!Number.isFinite(huf) || huf <= 0 || !Number.isFinite(hufPerUsd) || hufPerUsd <= 0) {
    throw new Error("A forint keretnek és a HUF/USD árfolyamnak pozitív számnak kell lennie.");
  }
  return (huf / hufPerUsd).toFixed(8);
}

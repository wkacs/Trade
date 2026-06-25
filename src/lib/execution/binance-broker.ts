import type { Order, Trade } from "@/lib/types";
import type { Broker } from "./broker";

/**
 * BinanceBroker — valós Binance Spot API. CSAK live módban, read+trade kulccsal,
 * SOHA withdraw jog. Lásd spec §3.3 + §6.
 *
 * BIZTONSÁG: a kockázati limiteket a Risk Manager már a broker előtt érvényesíti;
 * itt duplán is ellenőrizzük, hogy ne lehessen a limiteken túl kötni.
 *
 * MEGJEGYZÉS: a teljes Binance HMAC aláírás implementációja a 2. fázis (live mód)
 * feladata — amíg demo módban vagyunk, ez a vázlat jelzi az interfészt és a biztonsági
 * ellenőrzéseket. A tényleges hálózati hívás a live-módra váltás előtt implementálandó.
 */
export class BinanceBroker implements Broker {
  constructor(
    private apiKey: string,
    private apiSecret: string,
  ) {
    if (!apiKey || !apiSecret) throw new Error("BinanceBroker: hiányzó API kulcsok");
  }

  async execute(order: Order, _currentPrice: number): Promise<Trade> {
    // Biztonsági dupla-ellenőrzés: stop-loss kötelező
    if (order.stopLossPct < 0.05) {
      throw new Error("BinanceBroker: stop-loss kötelező és min -5%");
    }
    // A tényleges Binance REST hívás (HMAC aláírással) a 2. fázisban jön.
    throw new Error("BinanceBroker.execute még nincs implementálva — 2. fázis (live mód).");
  }
}

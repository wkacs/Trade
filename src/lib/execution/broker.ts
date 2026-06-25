import type { Order, Trade } from "@/lib/types";

/** Végrehajtó réteg — cserélhető demo (paper) és valós (binance) között. Lásd spec §3.3. */
export interface Broker {
  execute(order: Order, currentPrice: number): Promise<Trade>;
}

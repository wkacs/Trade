import type { Order, Trade } from "@/lib/types";
import type { ExecutionIntent, Fill, OrderState } from "./contracts";

/**
 * Végrehajtó réteg — cserélhető demo (paper) és valós (binance) között. Lásd spec §3.3.
 *
 * @deprecated v1. Kétértelmű: az `amountUsd` BUY-nál költendő összeg, SELL-nél a hívó
 * készpénzéből képzett szám volt. Az új út az `ExecutionBroker` (v2), ami intentet kap
 * és fill-eket ad vissza. A v1 addig marad, amíg a T05/T06 át nem állítja a runtime-ot.
 */
export interface Broker {
  execute(order: Order, currentPrice: number): Promise<Trade>;
}

/** Egy megbízás beküldésének eredménye — a fill NEM garantált. */
export interface ExecutionReceipt {
  /** A tőzsdei (paperben szintetikus) order-azonosító; `unknown` állapotnál hiányozhat. */
  exchangeOrderId: string | null;
  /** A stabil client order ID, amivel az order később lekérdezhető. */
  clientOrderId: string;
  state: OrderState;
  /** A megbízáshoz eddig ismert teljesülések. Üres tömb = még nincs fill. */
  fills: Fill[];
  /** Elutasítás vagy ismeretlen állapot esetén a strukturált ok. */
  error?: { code: string; message: string };
}

/**
 * Végrehajtó réteg v2. Az intentből legfeljebb EGY megbízás lesz (stabil client order
 * ID), és a hívó a visszakapott fill-eket könyveli el — pontosan egyszer.
 */
export interface ExecutionBroker {
  /** Beküldi az intentet. Timeout esetén `unknown` állapotot ad, nem dob és nem küld újat. */
  submit(intent: ExecutionIntent): Promise<ExecutionReceipt>;
  /** Egy korábbi (esetleg ismeretlen állapotú) megbízás lekérdezése a client order ID-val. */
  lookup(intent: ExecutionIntent): Promise<ExecutionReceipt>;
}

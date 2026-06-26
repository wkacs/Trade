import type { Order, Trade } from "@/lib/types";
import type { Broker } from "./broker";

const PAPER_FEE_PCT = 0.001; // 0.1% szimulált díj

interface PaperState {
  cashUsd: number;
  positions: { symbol: string; qty: number; valueUsd: number }[];
}

/**
 * PaperBroker — demo módban, valós áron szimulál tranzakciót.
 * Lásd spec §3.3. A valós árat a hívó adja meg (CoinGecko-ból).
 */
export class PaperBroker implements Broker {
  constructor(private state: PaperState) {}

  async execute(order: Order, currentPrice: number): Promise<Trade> {
    // BUY soha ne költsön többet a rendelkezésre álló készpénznél — nincs tőkeáttétel
    // (leverage=1). Spec §3.3: a végrehajtási réteg is érvényesíti a limiteket. Enélkül
    // egy túlméretezett order negatívba vihetné a cash-t (ezt a hibát éles demo-adat is
    // megmutatta). Normál működésben (amountUsd ≤ 20% cash) a clamp nem aktiválódik.
    const gross =
      order.side === "BUY"
        ? Math.min(order.amountUsd, Math.max(0, this.state.cashUsd))
        : order.amountUsd;
    const feeUsd = gross * PAPER_FEE_PCT;
    const netUsd = gross - feeUsd;
    const qty = netUsd / currentPrice;

    if (order.side === "BUY") {
      this.state.cashUsd -= gross;
      const existing = this.state.positions.find((p) => p.symbol === order.symbol);
      if (existing) {
        existing.qty += qty;
        existing.valueUsd += netUsd;
      } else {
        this.state.positions.push({ symbol: order.symbol, qty, valueUsd: netUsd });
      }
    } else {
      this.state.cashUsd += gross;
      const existing = this.state.positions.find((p) => p.symbol === order.symbol);
      if (existing) {
        existing.qty -= qty;
        existing.valueUsd -= netUsd;
        if (existing.qty <= 0.0000001) {
          this.state.positions = this.state.positions.filter((p) => p.symbol !== order.symbol);
        }
      }
    }

    return {
      id: crypto.randomUUID(),
      orderId: crypto.randomUUID(),
      symbol: order.symbol,
      side: order.side,
      amountUsd: gross,
      price: currentPrice,
      qty,
      feeUsd,
      executedAt: Date.now(),
      mode: "paper",
    };
  }
}

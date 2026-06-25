import { describe, it, expect } from "vitest";
import { PaperBroker } from "@/lib/execution/paper-broker";

type PaperState = { cashUsd: number; positions: { symbol: string; qty: number; valueUsd: number }[] };

const mkState = (cashUsd: number, positions: PaperState["positions"] = []): PaperState => ({
  cashUsd,
  positions,
});

describe("PaperBroker", () => {
  it("BUY-t szimulált egyenleggel végrehoz, fee-vel", async () => {
    const broker = new PaperBroker(mkState(10000));
    const trade = await broker.execute(
      { side: "BUY", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05 },
      60000,
    );
    expect(trade.symbol).toBe("BTC");
    expect(trade.side).toBe("BUY");
    expect(trade.price).toBe(60000);
    expect(trade.qty).toBeCloseTo((2000 - 2) / 60000, 8); // 0.1% fee
    expect(trade.feeUsd).toBeCloseTo(2, 4); // 2000 * 0.001
    expect(trade.mode).toBe("paper");
  });

  it("BUY csökkenti a készpénzt és pozíciót nyit", async () => {
    const st = mkState(10000);
    const broker = new PaperBroker(st);
    await broker.execute({ side: "BUY", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05 }, 60000);
    expect(st.cashUsd).toBe(8000);
    expect(st.positions).toHaveLength(1);
    expect(st.positions[0].symbol).toBe("BTC");
  });

  it("meglévő pozícióra BUY növeli (nem új pozíció)", async () => {
    const st = mkState(10000);
    const broker = new PaperBroker(st);
    await broker.execute({ side: "BUY", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05 }, 60000);
    await broker.execute({ side: "BUY", symbol: "BTC", amountUsd: 1000, stopLossPct: 0.05 }, 60000);
    expect(st.positions).toHaveLength(1);
    expect(st.cashUsd).toBe(7000);
  });

  it("SELL lezárja a pozíciót", async () => {
    const broker = new PaperBroker(
      mkState(8000, [{ symbol: "BTC", qty: 0.0333, valueUsd: 2000 }]),
    );
    const trade = await broker.execute(
      { side: "SELL", symbol: "BTC", amountUsd: 2000, stopLossPct: 0.05 },
      60000,
    );
    expect(trade.side).toBe("SELL");
  });

  it("SELL növeli a készpénzt", async () => {
    const st = mkState(8000, [{ symbol: "BTC", qty: 0.0333, valueUsd: 2000 }]);
    const broker = new PaperBroker(st);
    await broker.execute({ side: "SELL", symbol: "BTC", amountUsd: 1000, stopLossPct: 0.05 }, 60000);
    expect(st.cashUsd).toBe(9000);
  });
});

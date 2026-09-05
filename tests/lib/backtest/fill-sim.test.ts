import { describe, it, expect } from "vitest";
import { simulateFill, protectionTriggers } from "@/lib/backtest/fill-sim";
import type { Candle } from "@/lib/backtest/types";

const candle = (o: number, h: number, l: number, c: number): Candle => ({
  ts: 0,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 0,
});

describe("simulateFill — tőzsdén ülő védőorder (exchange-stop)", () => {
  it("stop-loss a trigger-áron tölt (nincs gap), slippage-dzsel lefelé", () => {
    const f = simulateFill(
      { side: "SELL", kind: "stop-loss", model: "exchange-stop", qty: 2, triggerPrice: 100, candle: candle(105, 106, 99, 101) },
      0.001,
      10,
    )!;
    // base = min(100, open 105) = 100; fill = 100 * (1 - 0.001) = 99.9
    expect(f.fillPrice).toBeCloseTo(99.9, 6);
    expect(f.qty).toBeCloseTo(2, 6);
    expect(f.amountUsd).toBeCloseTo(99.9 * 2, 4);
  });

  it("stop-loss GAP-down: a rosszabb open-on tölt", () => {
    const f = simulateFill(
      { side: "SELL", kind: "stop-loss", model: "exchange-stop", qty: 1, triggerPrice: 100, candle: candle(94, 95, 90, 93) },
      0,
      0,
    )!;
    expect(f.fillPrice).toBeCloseTo(94, 6);
  });

  it("take-profit GAP-up: a pihenő limit a jobb open-on tölt", () => {
    const f = simulateFill(
      { side: "SELL", kind: "take-profit", model: "exchange-stop", qty: 1, triggerPrice: 100, candle: candle(108, 110, 107, 109) },
      0,
      0,
    )!;
    expect(f.fillPrice).toBeCloseTo(108, 6);
  });
});

describe("simulateFill — polling (a futó bot valósága)", () => {
  it("a trigger NEM tehet jobbá egy rosszabb megfigyelést", () => {
    // A bot 95-ös stoppal, de 90-en látja az árat → 90-en ad el, nem 95-ön.
    const f = simulateFill(
      { side: "SELL", kind: "stop-loss", model: "polling", qty: 1, triggerPrice: 95, candle: candle(90, 96, 89, 91), at: "open" },
      0,
      0,
    )!;
    expect(f.fillPrice).toBeCloseTo(90, 6);
  });

  it("a polling take-profit is a megfigyelt árra vágódik", () => {
    const f = simulateFill(
      { side: "SELL", kind: "take-profit", model: "polling", qty: 1, triggerPrice: 110, candle: candle(104, 120, 103, 105), at: "open" },
      0,
      0,
    )!;
    expect(f.fillPrice).toBeCloseTo(104, 6);
  });

  it("market BUY a KÖVETKEZŐ nyitón tölt (nincs look-ahead), slippage felfelé", () => {
    const f = simulateFill(
      { side: "BUY", kind: "market", model: "polling", amountUsd: 100, candle: candle(50, 51, 49, 55), at: "open" },
      0.001,
      20,
    )!;
    // a NYITÓ ár számít (50), nem a záró (55)
    expect(f.fillPrice).toBeCloseTo(50.1, 6);
    // A keret a DÍJAT IS tartalmazza: bruttó + díj = 100.
    expect(f.amountUsd + f.feeUsd).toBeCloseTo(100, 9);
    expect(f.qty).toBeCloseTo(f.amountUsd / 50.1, 9);
  });

  it("market SELL a nyitón, slippage lefelé", () => {
    const f = simulateFill(
      { side: "SELL", kind: "market", model: "polling", qty: 2, candle: candle(50, 51, 49, 60), at: "open" },
      0,
      20,
    )!;
    expect(f.fillPrice).toBeCloseTo(49.9, 6);
  });

  it("nulla qty/amount → null", () => {
    expect(
      simulateFill(
        { side: "SELL", kind: "stop-loss", model: "exchange-stop", qty: 0, triggerPrice: 100, candle: candle(100, 100, 100, 100) },
        0,
        0,
      ),
    ).toBeNull();
    expect(
      simulateFill({ side: "BUY", kind: "market", model: "polling", amountUsd: 0, candle: candle(1, 1, 1, 1) }, 0, 0),
    ).toBeNull();
  });
});

describe("protectionTriggers — a két modell nem ugyanazt látja", () => {
  const k = candle(100, 120, 90, 100);

  it("exchange-stop: a gyertyán BELÜLI mélypont is tüzeli a stopot", () => {
    expect(protectionTriggers(k, 95, null, "exchange-stop")).toBe("stop-loss");
  });

  it("polling: a bot csak a megfigyelt árat látja, a mélypontot nem", () => {
    expect(protectionTriggers(k, 95, null, "polling")).toBeNull();
  });

  it("exchange-stop: a gyertyán belüli csúcs tüzeli a take-profitot", () => {
    expect(protectionTriggers(k, null, 110, "exchange-stop")).toBe("take-profit");
    expect(protectionTriggers(k, null, 110, "polling")).toBeNull();
  });

  it("ugyanazon a gyertyán a STOP élvez elsőbbséget (konzervatív)", () => {
    expect(protectionTriggers(k, 95, 110, "exchange-stop")).toBe("stop-loss");
  });

  it("nincs beállított védelem → nincs tüzelés", () => {
    expect(protectionTriggers(k, null, null, "exchange-stop")).toBeNull();
    expect(protectionTriggers(k, 0, 0, "exchange-stop")).toBeNull();
  });
});

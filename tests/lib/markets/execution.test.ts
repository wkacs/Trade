import { describe, it, expect } from "vitest";
import {
  fillParamsForClass,
  stockClosingFilters,
  fillParamsForInstrument,
  stockSymbolFilters,
} from "@/lib/markets/execution";
import { findInstrument } from "@/lib/markets/registry";
import { simulatePaperFill } from "@/lib/execution/paper-fill";

const BTC = findInstrument("BTC")!;
const AAPL = findInstrument("AAPL")!;
const NOW = Date.parse("2026-02-02T15:00:00Z");

describe("markets/execution – paraméterek", () => {
  it("részvény: USD quote, nulla jutalék, tágabb spread", () => {
    const p = fillParamsForClass("stock");
    expect(p.quoteAsset).toBe("USD");
    expect(p.feePct).toBe("0");
    expect(p.spreadBps).toBeGreaterThan(fillParamsForClass("crypto").spreadBps);
  });

  it("kripto: a meglévő default (USDT, 0,1% díj)", () => {
    const p = fillParamsForClass("crypto");
    expect(p.quoteAsset).toBe("USDT");
    expect(p.feePct).toBe("0.001");
  });

  it("instrumentum-paraméter beteszi a quote-ot és a részvény-szűrőket", () => {
    const stock = fillParamsForInstrument(AAPL, NOW);
    expect(stock.quoteAsset).toBe("USD");
    expect(stock.filters?.tickSize).toBe("0.01");
    expect(stock.filters?.stepSize).toBe("1");
    expect(stock.nowMs).toBe(NOW);

    const crypto = fillParamsForInstrument(BTC, NOW);
    expect(crypto.quoteAsset).toBe("USDT");
    // Kriptónál a valós szűrő az exchangeInfo-ból jön, itt nincs beépített.
    expect(crypto.filters).toBeUndefined();
  });

  it("kripto override szűrőt átvesz", () => {
    const fake = stockSymbolFilters("BTC", "USDT", NOW); // csak alak-teszt
    const p = fillParamsForInstrument(BTC, NOW, fake);
    expect(p.filters).toBe(fake);
  });
});

describe("markets/execution – valós paper fill részvényre", () => {
  it("egész részvényre kerekít és USD-ben számol díjat", () => {
    const params = fillParamsForInstrument(AAPL, NOW);
    const res = simulatePaperFill(
      { side: "BUY", kind: "market", symbol: "AAPL", maxQuoteSpend: "1000", market: { last: "108" } },
      params,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Egész részvény (stepSize=1) → nincs tört mennyiség.
    expect(res.filledBaseQty).toBe("9");
    expect(res.feeAsset).toBe("USD");
    expect(res.feeAmount).toBe("0");
    // A "legfeljebb ennyit költünk" ígéret áll.
    expect(Number(res.grossQuoteAmount)).toBeLessThanOrEqual(1000);
  });

  it("a minimum notional alatti kötést elutasítja (nem csendes)", () => {
    const params = fillParamsForInstrument(AAPL, NOW);
    const res = simulatePaperFill(
      { side: "BUY", kind: "market", symbol: "AAPL", maxQuoteSpend: "0.5", market: { last: "108" } },
      params,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("exchange_rule");
  });
});

describe("stockClosingFilters – a MEGLÉVŐ pozíció zárása", () => {
  const NOW = Date.parse("2026-02-02T21:00:00Z");

  it("tört mennyiséget enged, hogy ne maradjon zárhatatlan maradvány", () => {
    const f = stockClosingFilters("AAPL", "USD", NOW);
    expect(Number(f.stepSize)).toBeLessThanOrEqual(0.001);
    expect(Number(f.minQty)).toBeLessThanOrEqual(0.001);
  });

  it("nincs minimális kötésérték: egy 0,20 USD-s maradék is zárható", () => {
    expect(Number(stockClosingFilters("AAPL", "USD", NOW).minNotional)).toBe(0);
  });

  it("az ár-lépésköz marad a centes tick", () => {
    expect(stockClosingFilters("AAPL", "USD", NOW).tickSize).toBe("0.01");
  });
});

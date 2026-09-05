import { describe, it, expect } from "vitest";
import { simulatePaperFill, referencePrice, DEFAULT_PAPER_FILL_PARAMS } from "@/lib/execution/paper-fill";

const params = { feePct: "0.001", slippageBps: 0, spreadBps: 0, quoteAsset: "USDT" };

describe("paper-fill — a stop nem tehet jobbá egy rosszabb megfigyelést", () => {
  it("95-ös stop és 90-es megfigyelt ár mellett NEM 95-ön tölt (audit §3)", () => {
    const r = simulatePaperFill(
      { side: "SELL", kind: "stop-loss", symbol: "BTC", baseQty: "1", triggerPrice: "95", market: { last: "90" } },
      params,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fillPrice).toBe("90");
    expect(r.grossQuoteAmount).toBe("90");
  });

  it("ha a megfigyelt ár JOBB a triggernél, a trigger a korlát (konzervatív)", () => {
    const r = simulatePaperFill(
      { side: "SELL", kind: "stop-loss", symbol: "BTC", baseQty: "1", triggerPrice: "95", market: { last: "100" } },
      params,
    );
    expect(r.ok && r.fillPrice).toBe("95");
    expect(r.ok && r.basis.source).toBe("trigger");
  });

  it("take-profitnál is a minimum érvényes: elavult adat nem hoz kedvezőbb árat", () => {
    const r = simulatePaperFill(
      { side: "SELL", kind: "take-profit", symbol: "BTC", baseQty: "1", triggerPrice: "110", market: { last: "104" } },
      params,
    );
    expect(r.ok && r.fillPrice).toBe("104");
  });

  it("trigger-ár nélküli stop elutasításra kerül", () => {
    const r = simulatePaperFill(
      { side: "SELL", kind: "stop-loss", symbol: "BTC", baseQty: "1", market: { last: "90" } },
      params,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("no_price");
  });
});

describe("paper-fill — spread és csúszás explicit", () => {
  it("bid/ask nélkül a last köré fél spreadet tesz", () => {
    expect(referencePrice("BUY", { last: "100" }, 20)).toEqual({ price: "100.1", source: "last" });
    expect(referencePrice("SELL", { last: "100" }, 20)).toEqual({ price: "99.9", source: "last" });
  });

  it("bid/ask elsőbbséget élvez a last-tal szemben", () => {
    expect(referencePrice("BUY", { last: "100", ask: "100.5" }, 20)).toEqual({ price: "100.5", source: "ask" });
    expect(referencePrice("SELL", { last: "100", bid: "99.4" }, 20)).toEqual({ price: "99.4", source: "bid" });
  });

  it("a csúszás a BUY-t rontja, a SELL-t is rontja", () => {
    const buy = simulatePaperFill(
      { side: "BUY", kind: "market", symbol: "BTC", maxQuoteSpend: "100", market: { last: "100" } },
      { ...params, slippageBps: 10 },
    );
    const sell = simulatePaperFill(
      { side: "SELL", kind: "market", symbol: "BTC", baseQty: "1", market: { last: "100" } },
      { ...params, slippageBps: 10 },
    );
    expect(buy.ok && buy.fillPrice).toBe("100.1");
    expect(sell.ok && sell.fillPrice).toBe("99.9");
  });

  it("ár nélkül strukturált elutasítás, nem néma nulla", () => {
    const r = simulatePaperFill({ side: "BUY", kind: "market", symbol: "BTC", maxQuoteSpend: "10", market: {} }, params);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("no_price");
  });
});

describe("paper-fill — a díj belefér a BUY keretbe", () => {
  it("a bruttó + díj pontosan a maxQuoteSpend", () => {
    const r = simulatePaperFill(
      { side: "BUY", kind: "market", symbol: "BTC", maxQuoteSpend: "100", market: { last: "50000" } },
      params,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number(r.grossQuoteAmount) + Number(r.feeAmount)).toBeCloseTo(100, 9);
    expect(Number(r.filledBaseQty)).toBeCloseTo(Number(r.grossQuoteAmount) / 50000, 12);
  });

  it("SELL-nél a díj a bruttóra jön, a mennyiség a megadott baseQty", () => {
    const r = simulatePaperFill(
      { side: "SELL", kind: "market", symbol: "BTC", baseQty: "0.001", market: { last: "60000" } },
      params,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filledBaseQty).toBe("0.001");
    expect(r.grossQuoteAmount).toBe("60");
    expect(r.feeAmount).toBe("0.06");
  });

  it("hiányzó vagy nulla méret elutasításra kerül (nincs nulla order)", () => {
    expect(simulatePaperFill({ side: "BUY", kind: "market", symbol: "BTC", market: { last: "1" } }, params).ok).toBe(false);
    expect(
      simulatePaperFill({ side: "SELL", kind: "market", symbol: "BTC", baseQty: "0", market: { last: "1" } }, params).ok,
    ).toBe(false);
  });

  it("az alapértelmezett paraméterek egyeznek a backtest költségfeltevésével", () => {
    expect(DEFAULT_PAPER_FILL_PARAMS.feePct).toBe("0.001");
    expect(DEFAULT_PAPER_FILL_PARAMS.slippageBps).toBe(5);
  });
});

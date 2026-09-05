import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  applyFill,
  applyFills,
  cashOf,
  positionQty,
  equityAt,
  unrealizedPnl,
  canSell,
  setStop,
  withReservation,
  type LedgerState,
} from "@/lib/portfolio/ledger";
import type { Fill } from "@/lib/execution/contracts";
import { add } from "@/lib/portfolio/money";

const PF = "pf-1";

function fill(over: Partial<Fill> & Pick<Fill, "side" | "filledBaseQty" | "grossQuoteAmount" | "fillPrice">): Fill {
  const orderId = over.exchangeOrderId ?? `o-${over.side}-${over.filledBaseQty}`;
  const tradeId = over.exchangeTradeId ?? "t-1";
  return {
    fillId: over.fillId ?? `paper:${orderId}:${tradeId}`,
    intentId: over.intentId ?? "i-1",
    portfolioId: over.portfolioId ?? PF,
    mode: over.mode ?? "paper",
    symbol: over.symbol ?? "BTC",
    side: over.side,
    exchangeOrderId: orderId,
    exchangeTradeId: tradeId,
    filledBaseQty: over.filledBaseQty,
    grossQuoteAmount: over.grossQuoteAmount,
    fillPrice: over.fillPrice,
    feeAmount: over.feeAmount ?? "0",
    feeAsset: over.feeAsset ?? "USDT",
    executedAt: over.executedAt ?? 1_700_000_000_000,
  };
}

const start = (cash = "100"): LedgerState => emptyLedger(PF, "paper", cash);

describe("ledger — azonos fill mindig azonos cash/qty/bekerülési értéket ad", () => {
  it("BUY: 2 USDT vétel 60000-en, 0,1% quote-díjjal", () => {
    const r = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.00003333", grossQuoteAmount: "1.9998", fillPrice: "60000", feeAmount: "0.0019998" }),
    );
    expect(r.applied).toBe(true);
    // cash = 100 − 1,9998 − 0,0019998
    expect(cashOf(r.state, "USDT")).toBe("97.9982002");
    expect(positionQty(r.state, "BTC")).toBe("0.00003333");
    // bekerülési érték = bruttó + quote-díj
    expect(r.state.positions.BTC.costBasisQuote).toBe("2.0017998");
  });

  it("a reducer determinisztikus: ugyanaz a fill kétszer, külön ledgeren, azonos állapot", () => {
    const f = fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.06" });
    const a = applyFill(start(), f).state;
    const b = applyFill(start(), f).state;
    expect(a).toEqual(b);
  });

  it("idempotens: ugyanaz a fill-kulcs másodszor nem mozgat egyenleget", () => {
    const f = fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.06" });
    const first = applyFill(start(), f);
    const second = applyFill(first.state, f);
    expect(second.applied).toBe(false);
    expect(second.error?.code).toBe("duplicate_fill");
    expect(cashOf(second.state, "USDT")).toBe(cashOf(first.state, "USDT"));
    expect(positionQty(second.state, "BTC")).toBe(positionQty(first.state, "BTC"));
  });
});

describe("ledger — a díj eszközönként pontosan egyszer számít", () => {
  it("quote-díj: a készpénzt csökkenti és a bekerülési értéket növeli", () => {
    const r = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.06", feeAsset: "USDT" }),
    );
    expect(cashOf(r.state, "USDT")).toBe("39.94");
    expect(r.state.positions.BTC.costBasisQuote).toBe("60.06");
  });

  it("base-díj: a jóváírt mennyiséget csökkenti, a bekerülési érték a bruttó marad", () => {
    const r = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.000001", feeAsset: "BTC" }),
    );
    expect(positionQty(r.state, "BTC")).toBe("0.000999");
    expect(cashOf(r.state, "USDT")).toBe("40");
    expect(r.state.positions.BTC.costBasisQuote).toBe("60");
  });

  it("harmadik eszközű (BNB) díj: a saját egyenlegében jelenik meg, USD-ből nem vonódik le", () => {
    const state = { ...start(), cash: { USDT: "100", BNB: "1" } };
    const r = applyFill(
      state,
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.0001", feeAsset: "BNB" }),
    );
    expect(cashOf(r.state, "USDT")).toBe("40");
    expect(cashOf(r.state, "BNB")).toBe("0.9999");
    expect(r.state.positions.BTC.costBasisQuote).toBe("60");
  });

  it("SELL quote-díja egyszer csökkenti a bevételt (a régi kód a bruttót írta a cash-hez)", () => {
    const bought = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.06" }),
    ).state;
    const sold = applyFill(
      bought,
      fill({
        side: "SELL",
        filledBaseQty: "0.001",
        grossQuoteAmount: "60",
        fillPrice: "60000",
        feeAmount: "0.06",
        exchangeOrderId: "o-sell",
      }),
    );
    // 39,94 + 60 − 0,06 = 99,88 → a teljes veszteség pontosan a két díj (0,12).
    expect(cashOf(sold.state, "USDT")).toBe("99.88");
    expect(sold.realizedPnlQuote).toBe("-0.12");
  });
});

describe("ledger — változatlan áron a veszteség pontosan a költség", () => {
  it("BUY → SELL ugyanazon az áron: realizált eredmény = −(vételi díj + eladási díj)", () => {
    const buyFee = "0.06";
    const sellFee = "0.06";
    const after = applyFills(start("100"), [
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: buyFee }),
      fill({
        side: "SELL",
        filledBaseQty: "0.001",
        grossQuoteAmount: "60",
        fillPrice: "60000",
        feeAmount: sellFee,
        exchangeOrderId: "o-sell",
      }),
    ]);
    expect(after.state.realizedPnlQuote).toBe("-0.12");
    expect(cashOf(after.state, "USDT")).toBe("99.88");
    expect(after.state.positions.BTC).toBeUndefined();
  });
});

describe("ledger — részleges zárás arányos bekerülési értékkel", () => {
  it("fél pozíció eladása a bekerülési érték felét viszi", () => {
    const bought = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.002", grossQuoteAmount: "60", fillPrice: "30000", feeAmount: "0" }),
    ).state;
    const half = applyFill(
      bought,
      fill({
        side: "SELL",
        filledBaseQty: "0.001",
        grossQuoteAmount: "33",
        fillPrice: "33000",
        feeAmount: "0",
        exchangeOrderId: "o-half",
      }),
    );
    expect(positionQty(half.state, "BTC")).toBe("0.001");
    expect(half.state.positions.BTC.costBasisQuote).toBe("30");
    expect(half.realizedPnlQuote).toBe("3");
  });

  it("a második fél zárása után a pozíció eltűnik és a teljes eredmény összeáll", () => {
    let s = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.002", grossQuoteAmount: "60", fillPrice: "30000" }),
    ).state;
    s = applyFill(
      s,
      fill({ side: "SELL", filledBaseQty: "0.001", grossQuoteAmount: "33", fillPrice: "33000", exchangeOrderId: "o-1" }),
    ).state;
    s = applyFill(
      s,
      fill({ side: "SELL", filledBaseQty: "0.001", grossQuoteAmount: "27", fillPrice: "27000", exchangeOrderId: "o-2" }),
    ).state;
    expect(s.positions.BTC).toBeUndefined();
    expect(s.realizedPnlQuote).toBe("0");
    expect(cashOf(s, "USDT")).toBe("100");
  });

  it("dust-küszöb: a maradék bekerülési érték is realizálódik, nem ragad bent", () => {
    const bought = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.002", grossQuoteAmount: "60", fillPrice: "30000" }),
    ).state;
    const sold = applyFill(
      bought,
      fill({
        side: "SELL",
        filledBaseQty: "0.0019999999",
        grossQuoteAmount: "59.999997",
        fillPrice: "30000",
        exchangeOrderId: "o-dust",
      }),
      { dustBaseQty: "0.000001" },
    );
    expect(sold.state.positions.BTC).toBeUndefined();
    expect(Number(sold.realizedPnlQuote)).toBeCloseTo(-0.000003, 9);
  });
});

describe("ledger — tiltott negatív egyenleg és készlet", () => {
  it("fedezethiányos BUY elutasításra kerül, az állapot változatlan", () => {
    const s = start("1");
    const r = applyFill(s, fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000" }));
    expect(r.applied).toBe(false);
    expect(r.error?.code).toBe("insufficient_cash");
    expect(cashOf(r.state, "USDT")).toBe("1");
  });

  it("nem birtokolt coin eladása elutasításra kerül (orphan SELL)", () => {
    const r = applyFill(start(), fill({ side: "SELL", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000" }));
    expect(r.applied).toBe(false);
    expect(r.error?.code).toBe("insufficient_position");
  });

  it("túlméretes eladás elutasításra kerül", () => {
    const bought = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000" }),
    ).state;
    const r = applyFill(
      bought,
      fill({ side: "SELL", filledBaseQty: "0.002", grossQuoteAmount: "120", fillPrice: "60000", exchangeOrderId: "o-big" }),
    );
    expect(r.applied).toBe(false);
    expect(r.error?.code).toBe("insufficient_position");
    expect(positionQty(r.state, "BTC")).toBe("0.001");
  });

  it("a hatókör-eltérés (más portfólió vagy mód) elutasításra kerül", () => {
    const r = applyFill(start(), fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", mode: "live" }));
    expect(r.error?.code).toBe("scope_mismatch");
  });

  it("applyFills az első valódi hibánál megáll, nem könyvel félig", () => {
    const res = applyFills(start("100"), [
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", exchangeOrderId: "o-a" }),
      fill({ side: "SELL", filledBaseQty: "5", grossQuoteAmount: "300000", fillPrice: "60000", exchangeOrderId: "o-b" }),
      fill({ side: "BUY", filledBaseQty: "0.0001", grossQuoteAmount: "6", fillPrice: "60000", exchangeOrderId: "o-c" }),
    ]);
    expect(res.error?.code).toBe("insufficient_position");
    expect(cashOf(res.state, "USDT")).toBe("40");
    expect(res.results).toHaveLength(2);
  });
});

describe("ledger — származtatott mutatók és segédek", () => {
  it("equity és nem realizált eredmény az aktuális árakon", () => {
    const s = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000" }),
    ).state;
    expect(equityAt(s, { BTC: "60000" })).toBe("100");
    expect(equityAt(s, { BTC: "66000" })).toBe("106");
    expect(unrealizedPnl(s, { BTC: "66000" })).toBe("6");
    // Hiányzó ár: az adott pozíció kimarad, nincs kitalált érték.
    expect(equityAt(s, {})).toBe("40");
  });

  it("canSell csak a birtokolt készletre igaz", () => {
    const s = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000" }),
    ).state;
    expect(canSell(s, "BTC", "0.001")).toBe(true);
    expect(canSell(s, "BTC", "0.0011")).toBe(false);
    expect(canSell(s, "ETH", "0.001")).toBe(false);
  });

  it("setStop csak meglévő pozíción hat", () => {
    const s = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000" }),
      { stopPrice: "57000" },
    ).state;
    expect(s.positions.BTC.stopPrice).toBe("57000");
    expect(setStop(s, "BTC", "58000").positions.BTC.stopPrice).toBe("58000");
    expect(setStop(s, "ETH", "1").positions.ETH).toBeUndefined();
  });

  it("a deltak alakja megegyezik az apply_fill_v2 bemenetével", () => {
    const r = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.06" }),
      { stopPrice: "57000" },
    );
    expect(r.deltas).toEqual({
      cash: [{ asset: "USDT", delta: "-60.06" }],
      position: { symbol: "BTC", qtyDelta: "0.001", costDelta: "60.06", stopPrice: "57000" },
      reservation: null,
    });
    const withRes = withReservation(r.deltas!, "i-1", "60.06");
    expect(withRes.reservation).toEqual({ intentId: "i-1", consumeQuote: "60.06" });
  });

  it("a cash-delta összege megegyezik a tényleges egyenlegváltozással", () => {
    const before = start();
    const r = applyFill(
      before,
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000", feeAmount: "0.06" }),
    );
    const delta = r.deltas!.cash.find((c) => c.asset === "USDT")!.delta;
    expect(add(cashOf(before, "USDT"), delta)).toBe(cashOf(r.state, "USDT"));
  });
});

describe("ledger — a rávásárlás nem viszi lejjebb a trailing stopot (T08)", () => {
  it("AUDIT §4: a felhúzott stop megmarad, ha az új BUY alacsonyabb stopot kérne", () => {
    const opened = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000" }),
      { stopPrice: "57000" },
    ).state;
    // Trailing ratchet felhúzta a stopot 66000-es árnál 62700-ra.
    const ratcheted = setStop(opened, "BTC", "62700");
    expect(ratcheted.positions.BTC.stopPrice).toBe("62700");

    // Rávásárlás 66000-en: a naiv entry*(1−5%) = 62700-nál ALACSONYABB stopot kérne.
    const addOn = applyFill(
      ratcheted,
      fill({
        side: "BUY",
        filledBaseQty: "0.0001",
        grossQuoteAmount: "6.6",
        fillPrice: "66000",
        exchangeOrderId: "o-add",
      }),
      { stopPrice: "60000" },
    );
    expect(addOn.applied).toBe(true);
    expect(addOn.state.positions.BTC.stopPrice).toBe("62700");
  });

  it("a MAGASABB kért stop viszont érvényre jut", () => {
    const opened = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000" }),
      { stopPrice: "57000" },
    ).state;
    const addOn = applyFill(
      opened,
      fill({
        side: "BUY",
        filledBaseQty: "0.0001",
        grossQuoteAmount: "6.6",
        fillPrice: "66000",
        exchangeOrderId: "o-add2",
      }),
      { stopPrice: "62700" },
    );
    expect(addOn.state.positions.BTC.stopPrice).toBe("62700");
  });

  it("stopPrice nélküli rávásárlás sem nyúl a meglévő stophoz", () => {
    const opened = applyFill(
      start(),
      fill({ side: "BUY", filledBaseQty: "0.001", grossQuoteAmount: "60", fillPrice: "60000" }),
      { stopPrice: "57000" },
    ).state;
    const addOn = applyFill(
      opened,
      fill({ side: "BUY", filledBaseQty: "0.0001", grossQuoteAmount: "6", fillPrice: "60000", exchangeOrderId: "o-add3" }),
    );
    expect(addOn.state.positions.BTC.stopPrice).toBe("57000");
  });
});

import { describe, it, expect } from "vitest";
import {
  planProtection,
  protectionGate,
  incidentsFromOutcomes,
  protectionGaps,
  planRecovery,
  type ProtectionOrder,
  type ProtectionPosition,
  type ProtectionInput,
} from "@/lib/execution/protection";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import type { SymbolFilters } from "@/lib/execution/exchange-rules";

const NOW = 1_700_000_000_000;

const filters: SymbolFilters = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  status: "TRADING",
  tickSize: "0.01",
  minPrice: "0.01",
  maxPrice: "1000000",
  stepSize: "0.00001",
  minQty: "0.00001",
  maxQty: "9000",
  marketStepSize: null,
  marketMinQty: null,
  marketMaxQty: null,
  minNotional: "5",
  applyMinToMarket: true,
  fetchedAt: NOW,
};

const position = (over: Partial<ProtectionPosition> = {}): ProtectionPosition => ({
  symbol: "BTC",
  qty: "0.001",
  desiredStop: "57000",
  ...over,
});

const order = (over: Partial<ProtectionOrder> = {}): ProtectionOrder => ({
  symbol: "BTC",
  exchangeOrderId: "p-1",
  clientOrderId: "zct-p-1",
  qty: "0.001",
  stopPrice: "57000",
  limitPrice: "56942.94",
  state: "pending",
  placedAt: NOW,
  ...over,
});

const plan = (over: Partial<ProtectionInput> = {}) =>
  planProtection(
    {
      positions: [position()],
      existing: {},
      filters: { BTC: filters },
      ...over,
    },
    DEFAULT_STRATEGY,
  );

describe("planProtection — a NETTÓ birtokolt mennyiség védendő (T26)", () => {
  it("védőorder nélküli pozícióra FELADÁS és blokkoló incidens", () => {
    const p = plan();
    expect(p.actions).toEqual([
      expect.objectContaining({ kind: "place", symbol: "BTC", qty: "0.001", stopPrice: "57000" }),
    ]);
    expect(p.incidents[0].code).toBe("unprotected_position");
    expect(p.incidents[0].blocksNewBuys).toBe(true);
  });

  it("egyező mennyiség és stop mellett nincs teendő", () => {
    const p = plan({ existing: { BTC: order() } });
    expect(p.actions).toEqual([]);
    expect(p.incidents).toEqual([]);
  });

  it("RÁVÁSÁRLÁS után a védett mennyiség kevés → csere ÉS blokkoló incidens", () => {
    const p = plan({ positions: [position({ qty: "0.002" })], existing: { BTC: order({ qty: "0.001" }) } });
    expect(p.actions[0]).toMatchObject({ kind: "replace", cancelOrderId: "p-1", qty: "0.002" });
    const mismatch = p.incidents.find((i) => i.code === "qty_mismatch")!;
    expect(mismatch.blocksNewBuys).toBe(true);
  });

  it("RÉSZLEGES eladás után a védett mennyiség sok → csere, de nem blokkol", () => {
    const p = plan({ positions: [position({ qty: "0.0005" })], existing: { BTC: order({ qty: "0.001" }) } });
    expect(p.actions[0]).toMatchObject({ kind: "replace", qty: "0.0005" });
    expect(p.incidents.find((i) => i.code === "qty_mismatch")!.blocksNewBuys).toBe(false);
  });

  it("a trailing ratchet a TŐZSDEI ordert is cseréli (a DB-frissítés nem elég)", () => {
    const p = plan({ positions: [position({ desiredStop: "62700" })], existing: { BTC: order({ stopPrice: "57000" }) } });
    expect(p.actions[0]).toMatchObject({ kind: "replace", stopPrice: "62700" });
    expect(p.incidents.find((i) => i.code === "stale_stop")).toBeTruthy();
  });

  it("stop-ár nélküli pozíció VÉDELEM NÉLKÜLI, és tiltja az új vételt", () => {
    const p = plan({ positions: [position({ desiredStop: null })] });
    expect(p.actions).toEqual([]);
    expect(p.incidents[0].code).toBe("unprotected_position");
    expect(p.incidents[0].blocksNewBuys).toBe(true);
  });

  it("szűrőkészlet nélkül nem tervezünk védőordert, és tiltjuk a vételt", () => {
    const p = plan({ filters: {} });
    expect(p.actions).toEqual([]);
    expect(p.incidents[0].code).toBe("missing_filters");
    expect(p.incidents[0].blocksNewBuys).toBe(true);
  });

  it("lezárt pozíció árva védőordere törlésre kerül", () => {
    const p = plan({ positions: [position({ qty: "0" })], existing: { BTC: order() } });
    expect(p.actions[0]).toMatchObject({ kind: "cancel", cancelOrderId: "p-1" });
    expect(p.incidents[0].code).toBe("orphan_protection");
    expect(p.incidents[0].blocksNewBuys).toBe(false);
  });

  it("pozíció nélküli védőorder is árva", () => {
    const p = plan({ positions: [], existing: { ETH: order({ symbol: "ETH", exchangeOrderId: "p-eth" }) } });
    expect(p.actions[0]).toMatchObject({ kind: "cancel", symbol: "ETH", cancelOrderId: "p-eth" });
  });

  it("a védőorder árai a tőzsdei tickSize-ra kerekülnek, a limit a stop ALATT", () => {
    const p = plan({ positions: [position({ desiredStop: "57123.456789" })] });
    const action = p.actions[0];
    expect(action.stopPrice).toBe("57123.45");
    expect(Number(action.limitPrice)).toBeLessThan(Number(action.stopPrice));
  });
});

describe("protectionGate — nincs normál BUY-folytatás elbukott stop után", () => {
  it("blokkoló incidens mellett NEM szabad új vétel", () => {
    const p = plan();
    const gate = protectionGate(p.incidents);
    expect(gate.allowNewBuys).toBe(false);
    expect(gate.blocking).toHaveLength(1);
  });

  it("csak nem blokkoló incidensnél mehet a vétel", () => {
    const p = plan({ positions: [position({ qty: "0" })], existing: { BTC: order() } });
    expect(protectionGate(p.incidents).allowNewBuys).toBe(true);
  });

  it("incidens nélkül szabad az út", () => {
    expect(protectionGate([]).allowNewBuys).toBe(true);
  });
});

describe("végrehajtási kimenetel → incidensek", () => {
  const placeAction = { kind: "place" as const, symbol: "BTC", qty: "0.001", stopPrice: "57000", limitPrice: "56942.94", reason: "x" };
  const cancelAction = { kind: "cancel" as const, symbol: "BTC", cancelOrderId: "p-1", reason: "x" };

  it("elbukott FELADÁS blokkoló incidens (nem csak logsor)", () => {
    const inc = incidentsFromOutcomes([{ action: placeAction, ok: false, error: "-1013" }]);
    expect(inc[0].code).toBe("place_failed");
    expect(inc[0].blocksNewBuys).toBe(true);
    expect(inc[0].message).toMatch(/VÉDELEM NÉLKÜL/);
  });

  it("elbukott TÖRLÉS is blokkol (a készlet zárolva maradhat)", () => {
    const inc = incidentsFromOutcomes([{ action: cancelAction, ok: false, error: "-2011" }]);
    expect(inc[0].code).toBe("cancel_failed");
    expect(inc[0].blocksNewBuys).toBe(true);
  });

  it("a csere KÖZBEN bekövetkezett fill külön eset, nem hiba", () => {
    const inc = incidentsFromOutcomes([{ action: placeAction, ok: false, filledDuringReplace: true }]);
    expect(inc[0].code).toBe("fill_during_replace");
    expect(inc[0].blocksNewBuys).toBe(false);
  });

  it("sikeres műveletek nem generálnak incidenst", () => {
    expect(incidentsFromOutcomes([{ action: placeAction, ok: true, newOrderId: "p-2" }])).toEqual([]);
  });
});

describe("helyreállítás és rés-jelentés", () => {
  it("induláskor a védelem nélküli pozíció felderíthető", () => {
    const r = planRecovery(
      { positions: [position()], existing: {}, filters: { BTC: filters } },
      DEFAULT_STRATEGY,
    );
    expect(r.actions[0].kind).toBe("place");
    expect(protectionGate(r.incidents).allowNewBuys).toBe(false);
  });

  it("a rés-jelentés megmutatja a védetlen mennyiséget", () => {
    const gaps = protectionGaps([position({ qty: "0.002" })], { BTC: order({ qty: "0.001" }) });
    expect(gaps).toEqual([{ symbol: "BTC", held: "0.002", protectedQty: "0.001", gap: "0.001" }]);
  });

  it("teljesen védett pozíció nem jelenik meg résként", () => {
    expect(protectionGaps([position()], { BTC: order() })).toEqual([]);
  });
});

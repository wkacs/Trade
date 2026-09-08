import { describe, it, expect } from "vitest";
import {
  instrumentTradability,
  tradabilitySnapshot,
  tradableInstruments,
} from "@/lib/markets/tradability";
import { findInstrument } from "@/lib/markets/registry";

const BTC = findInstrument("BTC")!;
const AAPL = findInstrument("AAPL")!;

const JAN_MON_10ET = Date.parse("2026-01-05T15:00:00Z"); // részvény nyitva
const JAN_SAT = Date.parse("2026-01-03T15:00:00Z"); // részvény zárva (hétvége)

describe("markets/tradability", () => {
  it("a kripto mindig kereskedhető", () => {
    expect(instrumentTradability(BTC, JAN_SAT).tradable).toBe(true);
    expect(instrumentTradability(BTC, JAN_SAT).session.reason).toBe("crypto-always-open");
  });

  it("a részvény csak a szabályos ülésben kereskedhető", () => {
    expect(instrumentTradability(AAPL, JAN_MON_10ET).tradable).toBe(true);
    const weekend = instrumentTradability(AAPL, JAN_SAT);
    expect(weekend.tradable).toBe(false);
    expect(weekend.session.reason).toBe("weekend");
  });

  it("snapshot minden aktív instrumentumra egy sort ad", () => {
    const snap = tradabilitySnapshot(JAN_MON_10ET, { MARKETS_ENABLE_STOCKS: "1" });
    expect(snap.length).toBeGreaterThan(3);
    expect(snap.every((s) => typeof s.tradable === "boolean")).toBe(true);
  });

  it("hétvégén részvény kimarad a kereskedhetőkből, kripto marad", () => {
    const list = tradableInstruments(JAN_SAT, { MARKETS_ENABLE_STOCKS: "1" });
    const symbols = list.map((i) => i.symbol);
    expect(symbols).toContain("BTC");
    expect(symbols).not.toContain("AAPL");
  });

  it("ülés közben a részvény is a kereskedhetők között van", () => {
    const symbols = tradableInstruments(JAN_MON_10ET, { MARKETS_ENABLE_STOCKS: "1" }).map((i) => i.symbol);
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("BTC");
  });
});

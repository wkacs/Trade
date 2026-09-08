import { describe, it, expect } from "vitest";
import {
  etParts,
  isUsTradingDay,
  usEquitySession,
  marketSession,
  isMarketOpen,
} from "@/lib/markets/calendar";

// Rögzített, egyértelmű pillanatok. Január = EST (UTC-5), július = EDT (UTC-4).
const JAN_MON_10ET = Date.parse("2026-01-05T15:00:00Z"); // hétfő 10:00 ET → ülés
const JAN_MON_08ET = Date.parse("2026-01-05T13:00:00Z"); // hétfő 08:00 ET → pre-market
const JAN_MON_17ET = Date.parse("2026-01-05T22:00:00Z"); // hétfő 17:00 ET → after-hours
const JAN_SAT = Date.parse("2026-01-03T15:00:00Z"); // szombat
const NEW_YEAR = Date.parse("2026-01-01T15:00:00Z"); // ünnep (csütörtök, mégis zárva)
const JUL_MON_10ET = Date.parse("2026-07-06T14:00:00Z"); // hétfő 10:00 EDT → ülés (DST!)

describe("markets/calendar", () => {
  it("ET fali-órát ad (téli EST)", () => {
    const p = etParts(JAN_MON_10ET);
    expect(p).toMatchObject({ year: 2026, month: 1, day: 5, hour: 10, minute: 0, weekday: 1 });
  });

  it("DST-t az Intl kezeli — nyáron ugyanaz a UTC EDT-t ad", () => {
    // 14:00 UTC nyáron 10:00 ET (EDT). Kézi EST-offszettel tévesen 09:00 lenne.
    const p = etParts(JUL_MON_10ET);
    expect(p.hour).toBe(10);
    expect(usEquitySession(JUL_MON_10ET).open).toBe(true);
  });

  it("szabályos ülésben a részvénypiac nyitva", () => {
    expect(usEquitySession(JAN_MON_10ET)).toEqual({ open: true, reason: "regular-session" });
  });

  it("nyitás előtt és zárás után zárva", () => {
    expect(usEquitySession(JAN_MON_08ET)).toEqual({ open: false, reason: "pre-market" });
    expect(usEquitySession(JAN_MON_17ET)).toEqual({ open: false, reason: "after-hours" });
  });

  it("hétvégén és ünnepnapon zárva", () => {
    expect(usEquitySession(JAN_SAT)).toEqual({ open: false, reason: "weekend" });
    expect(usEquitySession(NEW_YEAR)).toEqual({ open: false, reason: "holiday" });
  });

  it("isUsTradingDay: hétköznap igen, hétvége/ünnep nem", () => {
    expect(isUsTradingDay(JAN_MON_10ET)).toBe(true);
    expect(isUsTradingDay(JAN_SAT)).toBe(false);
    expect(isUsTradingDay(NEW_YEAR)).toBe(false);
  });

  it("a kripto MINDIG nyitva — ünnepnapon és hétvégén is", () => {
    expect(marketSession("crypto", NEW_YEAR)).toEqual({ open: true, reason: "crypto-always-open" });
    expect(isMarketOpen("crypto", JAN_SAT)).toBe(true);
    expect(isMarketOpen("stock", JAN_SAT)).toBe(false);
  });
});

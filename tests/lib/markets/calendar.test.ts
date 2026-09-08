import { describe, it, expect } from "vitest";
import {
  etParts,
  sessionOpenMs,
  isUsTradingDay,
  usEquitySession,
  marketSession,
  isMarketOpen,
  isHalfDay,
  sessionCloseMinute,
  minutesToSessionClose,
  minutesFromSessionOpen,
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

describe("markets/calendar – korai zárású (fél-napos) ülések", () => {
  // 2026-11-27 péntek, a hálaadás utáni nap: 09:30–13:00 ET (EST = UTC−5).
  const halfDay = (etHour: number, etMin: number) => Date.UTC(2026, 10, 27, etHour + 5, etMin);
  // 2026-12-01 kedd: szabályos ülés.
  const fullDay = (etHour: number, etMin: number) => Date.UTC(2026, 11, 1, etHour + 5, etMin);

  it("felismeri a korai zárású napot", () => {
    expect(isHalfDay(halfDay(12, 0))).toBe(true);
    expect(isHalfDay(fullDay(12, 0))).toBe(false);
  });

  it("a zárás perce 13:00 fél-napon, 16:00 egyébként", () => {
    expect(sessionCloseMinute(halfDay(12, 0))).toBe(13 * 60);
    expect(sessionCloseMinute(fullDay(12, 0))).toBe(16 * 60);
  });

  it("fél-napon 13:00 UTÁN már ZÁRVA van (korábban 16:00-ig nyitva látszott)", () => {
    expect(usEquitySession(halfDay(12, 59)).open).toBe(true);
    expect(usEquitySession(halfDay(13, 1))).toEqual({ open: false, reason: "after-hours" });
    // Ugyanez az óra szabályos napon MÉG ülés.
    expect(usEquitySession(fullDay(13, 1)).open).toBe(true);
  });

  it("a zárásig hátralévő perc a KORAI záráshoz igazodik", () => {
    expect(minutesToSessionClose(halfDay(12, 0))).toBe(60);
    expect(minutesToSessionClose(fullDay(12, 0))).toBe(240);
  });

  it("a nyitás 09:30 marad fél-napon is", () => {
    expect(minutesFromSessionOpen(halfDay(10, 0))).toBe(30);
    expect(minutesFromSessionOpen(halfDay(14, 0))).toBeNull();
  });
});

describe("sessionOpenMs", () => {
  it("az aznapi 09:30 ET-t adja vissza (téli időszámítás)", () => {
    const midSession = Date.parse("2026-02-02T15:47:30Z"); // 10:47 ET
    expect(new Date(sessionOpenMs(midSession)).toISOString()).toBe("2026-02-02T14:30:00.000Z");
  });

  it("nyári időszámításban is a 09:30 ET-t adja (más UTC-eltolás)", () => {
    const midSession = Date.parse("2026-06-02T16:00:00Z"); // 12:00 ET (EDT)
    expect(new Date(sessionOpenMs(midSession)).toISOString()).toBe("2026-06-02T13:30:00.000Z");
  });

  it("nyitás előtt is az aznapi nyitást adja (a jövőben)", () => {
    const preMarket = Date.parse("2026-02-02T14:00:00Z"); // 09:00 ET
    expect(sessionOpenMs(preMarket)).toBe(Date.parse("2026-02-02T14:30:00Z"));
  });
});

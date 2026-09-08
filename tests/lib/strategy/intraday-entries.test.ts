import { describe, it, expect } from "vitest";
import {
  todaysBars,
  sessionVwap,
  breaksOpeningRange,
  breakoutShape,
  orbShape,
  orbTrendShape,
  gapGoShape,
  vwapTrendShape,
  vwapCrossShape,
  pullbackShape,
  timeOfDayShape,
  regimeShape,
  ENTRY_SHAPES,
  alwaysShape,
  allOf,
  resolveEntryShape,
  type EntryShapeInput,
} from "@/lib/strategy/intraday-entries";
import { STOCK_INTRADAY_STRATEGY } from "@/lib/engine/stock-tick";
import type { OhlcvCandle } from "@/lib/market/candles";

/** 2026 júniusa EDT (UTC−4), tehát az ET-óra + 4 = UTC-óra. Június 15. hétfő. */
const at = (etHour: number, etMin: number, day = 15) => Date.UTC(2026, 5, day, etHour + 4, etMin);

/** Egy szabályos ülés 5 perces gyertyáinak száma: 09:30–16:00 = 390 perc. */
const BARS_PER_SESSION = 78;

function bar(openTime: number, close: number, over: Partial<OhlcvCandle> = {}): OhlcvCandle {
  return {
    symbol: "TEST",
    timeframe: "5m",
    openTime,
    closeTime: openTime + 5 * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    baseVolume: 100,
    quoteVolume: 100 * close,
    trades: 0,
    receivedAt: openTime,
    ...over,
  };
}

/** Egy ülés eleje (09:30-tól) a megadott záróárakkal. */
function session(closes: number[], day = 15, over: (i: number) => Partial<OhlcvCandle> = () => ({})): OhlcvCandle[] {
  return closes.map((c, i) => bar(at(9, 30, day) + i * 5 * 60_000, c, over(i)));
}

/**
 * Több üléses sor: a záróárakat 78-as adagokban osztja szét a megadott kereskedési
 * napokra. Enélkül egy hosszú sor „belelógna" a zárás utáni időbe, ahol az ülés-relatív
 * belépőknek (helyesen) nincs értelmezésük.
 */
function multiDay(closes: number[], days = [15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 29, 30]): OhlcvCandle[] {
  return closes.map((c, i) => {
    const day = days[Math.floor(i / BARS_PER_SESSION) % days.length];
    const slot = i % BARS_PER_SESSION;
    return bar(at(9, 30, day) + slot * 5 * 60_000, c);
  });
}

const input = (candles: OhlcvCandle[], rest: Partial<EntryShapeInput> = {}): EntryShapeInput => ({
  symbol: "TEST",
  candles,
  candlesBySymbol: { TEST: candles },
  strategy: STOCK_INTRADAY_STRATEGY,
  ...rest,
});

describe("intraday-entries – ülés-relatív segédek", () => {
  it("todaysBars CSAK az utolsó gyertya ET-napjának barjait adja", () => {
    const bars = [...session([10, 11], 15), ...session([20, 21, 22], 16)];
    expect(todaysBars(bars).map((b) => b.close)).toEqual([20, 21, 22]);
  });

  it("todaysBars üres sorra üreset ad", () => {
    expect(todaysBars([])).toEqual([]);
  });

  it("sessionVwap forgalommal súlyoz, nem egyszerű átlagot ad", () => {
    const bars = [
      bar(at(9, 30), 100, { high: 100, low: 100, baseVolume: 1 }),
      bar(at(9, 35), 200, { high: 200, low: 200, baseVolume: 9 }),
    ];
    // (100*1 + 200*9) / 10 = 190 — az egyszerű átlag 150 lenne.
    expect(sessionVwap(bars)).toBeCloseTo(190, 6);
  });

  it("sessionVwap null, ha nincs forgalom (nem oszt nullával)", () => {
    expect(sessionVwap([bar(at(9, 30), 100, { baseVolume: 0 })])).toBeNull();
  });
});

describe("intraday-entries – opening range breakout", () => {
  it("HAMIS, amíg a nyitó sáv még FORMÁLÓDIK", () => {
    // 09:30 és 09:35 bar: a 15 perces sáv még nem zárult le.
    expect(breaksOpeningRange(session([100, 105]), 15)).toBe(false);
  });

  it("IGAZ, ha a sáv lezárult és az utolsó close a sáv teteje FÖLÖTT van", () => {
    const bars = session([100, 101, 102, 103], 15, (i) => ({ high: [100, 101, 102, 103][i] }));
    // OR = az első három bar (09:30, 09:35, 09:40) → tető 102; a 09:45 close 103 > 102.
    expect(breaksOpeningRange(bars, 15)).toBe(true);
  });

  it("HAMIS, ha az ár a sávon BELÜL maradt", () => {
    const bars = session([100, 110, 102, 105], 15, (i) => ({ high: [100, 110, 102, 105][i] }));
    // OR-tető 110; a 09:45 close 105 alatta van.
    expect(breaksOpeningRange(bars, 15)).toBe(false);
  });

  it("a sávot NAPONKÉNT újraszámolja (a tegnapi tető nem számít)", () => {
    const yesterday = session([500, 500, 500, 500], 12, () => ({ high: 500 }));
    const today = session([100, 101, 102, 103], 15, (i) => ({ high: [100, 101, 102, 103][i] }));
    expect(breaksOpeningRange([...yesterday, ...today], 15)).toBe(true);
  });

  it("60 perces sáv esetén tovább vár, mint a 15 percesnél", () => {
    const closes = Array.from({ length: 8 }, (_, i) => 100 + i);
    const bars = session(closes, 15, (i) => ({ high: 100 + i }));
    expect(orbShape(15)(input(bars))).toBe(true);
    expect(orbShape(60)(input(bars))).toBe(false); // 8 bar = 40 perc, a sáv még nyitva
  });

  it("zárás utáni gyertyára HAMIS (nincs értelmezhető ülés-pozíció)", () => {
    const afterHours = [bar(at(17, 0), 100), bar(at(17, 5), 200, { high: 200 })];
    expect(breaksOpeningRange(afterHours, 15)).toBe(false);
  });
});

describe("intraday-entries – alakok", () => {
  const rising = Array.from({ length: 200 }, (_, i) => 100 + i);
  const risingBars = multiDay(rising);
  const fallingBars = multiDay(rising.map((c) => 400 - c));

  it("breakoutShape a jelenlegi éles jelet adja vissza (close > SMA és lookback-csúcs)", () => {
    expect(breakoutShape(input(risingBars))).toBe(true);
    expect(breakoutShape(input(fallingBars))).toBe(false);
  });

  it("orbTrendShape a kitöréshez trend-fölöttiséget IS kér", () => {
    // Zuhanó több napos trend, de a mai sáv tetejét átüti: az ORB igen, az ORB+trend nem.
    const older = multiDay(
      Array.from({ length: 100 }, (_, i) => 300 - i * 2),
      [8, 9, 10, 11, 12],
    );
    const today = session([100, 101, 102, 103], 15, (i) => ({ high: [100, 101, 102, 103][i] }));
    const bars = [...older, ...today];
    expect(orbShape(15)(input(bars))).toBe(true);
    expect(orbTrendShape(15)(input(bars))).toBe(false);
  });

  it("gapGoShape rés NÉLKÜL nem lép be", () => {
    const yesterday = session([100, 100, 100, 100], 12, () => ({ high: 100 }));
    const flatOpen = session([100, 101, 102, 103], 15, (i) => ({ high: [100, 101, 102, 103][i], open: 100 }));
    expect(gapGoShape(0.003, 15)(input([...yesterday, ...flatOpen]))).toBe(false);

    const gapOpen = session([110, 111, 112, 113], 15, (i) => ({
      high: [110, 111, 112, 113][i],
      open: i === 0 ? 110 : 111,
    }));
    expect(gapGoShape(0.003, 15)(input([...yesterday, ...gapOpen]))).toBe(true);
  });

  it("gapGoShape előző ülés nélkül HAMIS (nincs mihez mérni a rést)", () => {
    const only = session([110, 111, 112, 113], 15, (i) => ({ high: [110, 111, 112, 113][i] }));
    expect(gapGoShape(0.003, 15)(input(only))).toBe(false);
  });

  it("vwapTrendShape a VWAP fölött igaz, alatta hamis", () => {
    const up = [
      bar(at(9, 30), 100, { high: 100, low: 100, baseVolume: 10 }),
      bar(at(9, 35), 120, { high: 120, low: 120, baseVolume: 1 }),
    ];
    expect(vwapTrendShape(input(up))).toBe(true);
    const down = [
      bar(at(9, 30), 120, { high: 120, low: 120, baseVolume: 10 }),
      bar(at(9, 35), 100, { high: 100, low: 100, baseVolume: 1 }),
    ];
    expect(vwapTrendShape(input(down))).toBe(false);
  });

  it("vwapCrossShape CSAK az áttörés barján igaz, a fölötte maradáson nem", () => {
    const cross = [
      bar(at(9, 30), 100, { high: 100, low: 100, baseVolume: 10 }),
      bar(at(9, 35), 99, { high: 99, low: 99, baseVolume: 10 }),
      bar(at(9, 40), 130, { high: 130, low: 130, baseVolume: 1 }),
    ];
    expect(vwapCrossShape(input(cross))).toBe(true);
    // Egy további, szintén VWAP fölötti bar után már NEM friss a jel.
    const stayed = [...cross, bar(at(9, 45), 131, { high: 131, low: 131, baseVolume: 1 })];
    expect(vwapCrossShape(input(stayed))).toBe(false);
  });

  it("pullbackShape a hosszú trend FÖLÖTT, a rövid átlag ALATT, zöld baron lép be", () => {
    // Emelkedő sor, majd visszaesés és egy zöld bar: a rövid (78) átlag alatt, a hosszú
    // (390) átlag fölött vagyunk — ez a momentum ELLENTÉTE.
    const rise = Array.from({ length: 400 }, (_, i) => 100 + i * 0.5);
    expect(pullbackShape(390)(input(multiDay([...rise, 240, 250])))).toBe(true);
    // Csúcson (a rövid átlag FÖLÖTT) nem lép be.
    expect(pullbackShape(390)(input(multiDay([...rise, 400])))).toBe(false);
  });

  it("timeOfDayShape a sávon KÍVÜL nem enged belépőt", () => {
    // A sor utolsó barja a 200 % 78 = 44. slot, azaz a nyitás után 220 perccel.
    expect(breakoutShape(input(risingBars))).toBe(true);
    expect(timeOfDayShape(0, 90)(input(risingBars))).toBe(false);
    expect(timeOfDayShape(180, 300)(input(risingBars))).toBe(true);
  });

  it("regimeShape a referencia-papír trendjétől függ", () => {
    expect(
      regimeShape("SPY")(input(risingBars, { candlesBySymbol: { TEST: risingBars, SPY: risingBars } })),
    ).toBe(true);
    expect(
      regimeShape("SPY")(input(risingBars, { candlesBySymbol: { TEST: risingBars, SPY: fallingBars } })),
    ).toBe(false);
  });

  it("regimeShape HIÁNYZÓ referencia-papírnál hamis (nem tippel rezsimet)", () => {
    expect(regimeShape("SPY")(input(risingBars, { candlesBySymbol: { TEST: risingBars } }))).toBe(false);
  });

  it("a névtár minden bejegyzése hívható és boolean-t ad", () => {
    for (const [name, shape] of Object.entries(ENTRY_SHAPES)) {
      expect(typeof shape(input(risingBars)), name).toBe("boolean");
    }
  });
});

describe("intraday-entries – kontroll-alak és feloldás", () => {
  const bars = multiDay(Array.from({ length: 200 }, (_, i) => 100 + i));
  const inp = (): EntryShapeInput => ({
    symbol: "TEST",
    candles: bars,
    candlesBySymbol: { TEST: bars },
    strategy: STOCK_INTRADAY_STRATEGY,
  });

  it("alwaysShape mindig igaz (placebo, nem stratégia)", () => {
    expect(alwaysShape(inp())).toBe(true);
  });

  it("allOf üres listára DOB, nem enged át mindent", () => {
    expect(() => allOf()).toThrow();
  });

  it("resolveEntryShape ismert nevet old fel", () => {
    expect(resolveEntryShape("tod60+regime")).toBe(ENTRY_SHAPES["tod60+regime"]);
  });

  it("resolveEntryShape üres/hiányzó névre null (marad a beépített jel)", () => {
    expect(resolveEntryShape(undefined)).toBeNull();
    expect(resolveEntryShape("")).toBeNull();
    expect(resolveEntryShape("   ")).toBeNull();
  });

  it("resolveEntryShape ISMERETLEN névre null — nem kapcsol ki némán minden belépőt", () => {
    expect(resolveEntryShape("nincs-ilyen-alak")).toBeNull();
  });
});

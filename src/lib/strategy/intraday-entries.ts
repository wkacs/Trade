/**
 * Intraday BELÉPŐ-ALAKOK — a day-trading sáv stratégia-tere, tiszta függvényekben.
 *
 * Miért külön modul: a `passesMomentum` (kitörés a trend fölött) EGY belépő-alak a sok
 * közül. A kérdés, hogy melyik alak a legjobb, csak úgy dönthető el, ha több alak
 * UGYANAZON a végrehajtási úton, ugyanazon a gyertyasoron mérhető. Ezért a belépő itt
 * cserélhető: a `planStockCycle` opcionális `entryShape`-et kap, és ha kap, az dönti el a
 * `momentumOk` jelzőt symbolonként.
 *
 * Minden alak TISZTA: nincs DB, nincs hálózat, nincs `Date.now`. A bemenet lezárt,
 * idő szerint rendezett gyertyasor; az „utolsó gyertya" a most lezárult bar.
 *
 * FONTOS: az alakok csak a BELÉPŐ engedélyét adják. A méretezés, a kockázati keret, a
 * stop/take-profit és a nap végi laposra zárás változatlanul a közös gépezeté.
 */
import type { OhlcvCandle } from "@/lib/market/candles";
import type { StrategyConfig } from "@/lib/strategy/config";
import { etParts, etDateKey, minutesFromSessionOpen } from "@/lib/markets/calendar";
import { sma } from "@/lib/strategy/entry-filter";
import { passesMomentum } from "@/lib/strategy/momentum";

export interface EntryShapeInput {
  symbol: string;
  /** A symbol lezárt gyertyái (idő szerint; az utolsó a most lezárult bar). */
  candles: OhlcvCandle[];
  /** MINDEN figyelt symbol gyertyái — a rezsim-szűrőnek kell (pl. SPY állapota). */
  candlesBySymbol: Record<string, OhlcvCandle[]>;
  strategy: StrategyConfig;
}

/** Egy belépő-alak: igaz, ha MOST szabad belépni ebbe a papírba. */
export type EntryShape = (input: EntryShapeInput) => boolean;

// ── Ülés-relatív segédek ────────────────────────────────────────────────────────

/** Az aznapi (az utolsó gyertya ET-napjához tartozó) gyertyák, sorrendben. */
export function todaysBars(candles: OhlcvCandle[]): OhlcvCandle[] {
  if (candles.length === 0) return [];
  const key = etDateKey(etParts(candles[candles.length - 1].openTime));
  const out: OhlcvCandle[] = [];
  for (let i = candles.length - 1; i >= 0; i--) {
    if (etDateKey(etParts(candles[i].openTime)) !== key) break;
    out.push(candles[i]);
  }
  return out.reverse();
}

/** Az előző ülés UTOLSÓ gyertyája (a gap-méréshez). Null, ha nincs korábbi nap. */
function previousSessionLast(candles: OhlcvCandle[]): OhlcvCandle | null {
  const today = todaysBars(candles).length;
  const idx = candles.length - today - 1;
  return idx >= 0 ? candles[idx] : null;
}

/** Aznapi VWAP (tipikus ár × darabszám, kumulálva a nyitástól). Null, ha nincs forgalom. */
export function sessionVwap(bars: OhlcvCandle[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.baseVolume;
    v += b.baseVolume;
  }
  return v > 0 ? pv / v : null;
}

/**
 * Opening range breakout mag: igaz, ha a nyitó `orMinutes` perc sávja LEZÁRULT, és az
 * utolsó záróár a sáv teteje FÖLÖTT van.
 */
export function breaksOpeningRange(candles: OhlcvCandle[], orMinutes: number): boolean {
  const today = todaysBars(candles);
  if (today.length === 0) return false;
  const last = today[today.length - 1];
  const lastFromOpen = minutesFromSessionOpen(last.openTime);
  if (lastFromOpen === null || lastFromOpen < orMinutes) return false;

  let orHigh = -Infinity;
  for (const b of today) {
    const m = minutesFromSessionOpen(b.openTime);
    // Ülésen KÍVÜLI bar (pl. záró print) csak kimarad; korábban egy ilyen az egész napra
    // kioltotta a sávot, mert ugyanaz a break vitte, mint a sáv végét.
    if (m === null) continue;
    if (m >= orMinutes) break;
    orHigh = Math.max(orHigh, b.high);
  }
  if (!Number.isFinite(orHigh)) return false;
  return last.close > orHigh;
}

// ── A belépő-alakok ─────────────────────────────────────────────────────────────

/**
 * A JELENLEGI ÉLES alak: kitörés a trend fölött (close > SMA ÉS = az utolsó `lookback`
 * záróár maximuma). Referencia-pont a többi alakhoz.
 */
export const breakoutShape: EntryShape = ({ candles, strategy }) =>
  passesMomentum(
    candles.map((c) => c.close),
    strategy.momentumSmaPeriod,
    strategy.momentumLookback,
  );

/**
 * Opening Range Breakout. A day trading klasszikusa: a nyitás utáni első percek sávja
 * adja a napi referencia-szintet, és a sáv tetejének átütése a belépő. Kizárólag
 * ÜLÉS-RELATÍV, tehát semmi köze a több napos trendhez.
 */
export const orbShape = (orMinutes: number): EntryShape => ({ candles }) =>
  breaksOpeningRange(candles, orMinutes);

/** ORB + több napos trend-szűrő (a kitörés csak emelkedő trendben számít). */
export const orbTrendShape = (orMinutes: number): EntryShape => ({ candles, strategy }) => {
  if (!breaksOpeningRange(candles, orMinutes)) return false;
  const closes = candles.map((c) => c.close);
  return closes[closes.length - 1] > sma(closes, strategy.momentumSmaPeriod);
};

/**
 * Gap-and-go: a nap RÉSSEL nyit az előző záróhoz képest, és utána átüti a nyitó sávot.
 * A rés jelzi, hogy új információ érkezett; az ORB, hogy a piac meg is tartja.
 */
export const gapGoShape = (minGapPct: number, orMinutes: number): EntryShape => ({ candles }) => {
  const today = todaysBars(candles);
  const prev = previousSessionLast(candles);
  if (today.length === 0 || !prev || prev.close <= 0) return false;
  const gap = today[0].open / prev.close - 1;
  if (gap < minGapPct) return false;
  return breaksOpeningRange(candles, orMinutes);
};

/**
 * VWAP fölött: az aznapi forgalom-súlyozott átlagár a nap „igazságos ára". Fölötte a
 * vevők vannak fölényben. Tartós jel (minden baron igaz maradhat) — a pozíció-limit fogja.
 */
export const vwapTrendShape: EntryShape = ({ candles }) => {
  const today = todaysBars(candles);
  if (today.length < 2) return false;
  const vwap = sessionVwap(today);
  if (vwap === null) return false;
  return today[today.length - 1].close > vwap;
};

/**
 * VWAP-áttörés: az ELŐZŐ bar még a VWAP alatt zárt, a mostani fölötte. Egyszeri,
 * friss jel a tartós „fölötte van" helyett.
 */
export const vwapCrossShape: EntryShape = ({ candles }) => {
  const today = todaysBars(candles);
  if (today.length < 3) return false;
  const vwapNow = sessionVwap(today);
  const vwapPrev = sessionVwap(today.slice(0, -1));
  if (vwapNow === null || vwapPrev === null) return false;
  const last = today[today.length - 1];
  const prev = today[today.length - 2];
  return prev.close <= vwapPrev && last.close > vwapNow;
};

/**
 * Visszaesés-vétel emelkedő trendben (mean reversion). A momentum ELLENTÉTE: hosszú
 * trend fölött, de a rövid átlag ALATT vásárol, egy zöld baron. Ha a momentum azért
 * gyenge, mert a csúcson vesz, ennek jobbnak KELL lennie — ha nem az, a piac tényleg
 * trendkövető ezen a skálán.
 */
export const pullbackShape = (longPeriod: number): EntryShape => ({ candles, strategy }) => {
  const closes = candles.map((c) => c.close);
  if (closes.length < longPeriod + 2) return false;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  return last > sma(closes, longPeriod) && last < sma(closes, strategy.momentumSmaPeriod) && last > prev;
};

/** Több alak ÉS-kapcsolata — a szűrők így rakhatók egymásra. */
export const allOf = (...shapes: EntryShape[]): EntryShape => {
  if (shapes.length === 0) throw new Error("allOf: legalább egy alak kell (az üres ÉS fail-open lenne)");
  return (input) => shapes.every((s) => s(input));
};

/**
 * Napszak-SZŰRŐ (önmagában nem belépő): igaz, ha a most lezárt bar NYITÓ ideje az ülés
 * adott percsávjában van. A nyitó időt használja, tehát a `[0, 30)` ablak a 09:55-kor
 * NYÍLÓ (és 10:00-kor záruló) bart még beengedi — a döntés így a bar zárásakor, a 30.
 * perc után is megszülethet.
 *
 * Mérve (60 nap, 5 perces gyertya): a nyitás utáni fél óra az EGYETLEN pozitív szakasz,
 * a 90. perc utáni szakaszok mind negatívak. Lásd docs/2026-09-08-reszveny-stratégia-verseny.md.
 */
export const timeWindowFilter = (fromMin: number, toMin: number): EntryShape => ({ candles }) => {
  const last = candles[candles.length - 1];
  if (!last) return false;
  const m = minutesFromSessionOpen(last.openTime);
  return m !== null && m >= fromMin && m < toMin;
};

/** Napszak-szűrős kitörés. */
export const timeOfDayShape = (fromMin: number, toMin: number): EntryShape =>
  allOf(timeWindowFilter(fromMin, toMin), breakoutShape);

/**
 * Rezsim-szűrő: a kitörés csak akkor számít, ha a PIAC (referencia-papír) is a saját
 * trendje fölött van. Egyetlen szűrő, ami az egész napot kikapcsolhatja.
 */
export const regimeFilter = (benchmark: string): EntryShape => (input) => {
  const bench = input.candlesBySymbol[benchmark];
  if (!bench || bench.length === 0) return false;
  const bCloses = bench.map((c) => c.close);
  // Rövid benchmark-sorra a mozgóátlag önmagát adná vissza (sma a MEGLÉVŐ elemekre átlagol),
  // és a szűrő némán FAIL-OPEN lenne: x >= x. Kevés adat esetén inkább NINCS engedély.
  if (bCloses.length < input.strategy.momentumSmaPeriod) return false;
  return bCloses[bCloses.length - 1] >= sma(bCloses, input.strategy.momentumSmaPeriod);
};

/** Rezsim-szűrős kitörés. */
export const regimeShape = (benchmark: string): EntryShape =>
  allOf(regimeFilter(benchmark), breakoutShape);

/**
 * KONTROLL-alak: mindig igaz. Nem stratégia, hanem placebo — vele a napszak-ablakok
 * hatása a BELÉPŐ JEL NÉLKÜL mérhető. Ha egy napszak-ablak ugyanannyit hoz `always`-szel,
 * mint a kitörés-jellel, akkor a jel nem ad semmit, és a hozam pusztán a tartási időből
 * és a piac sodrásából jön.
 */
export const alwaysShape: EntryShape = () => true;

/**
 * A mért alakok névtára.
 *
 * Az ÉLES ciklus a `STOCK_INTRADAY_ENTRY_SHAPE` környezeti változóval választ innen; ha
 * nincs beállítva, a beépített kitörés-jel dönt (változatlan viselkedés). Ismeretlen név
 * esetén a `resolveEntryShape` null-t ad és a hívó naplóz — némán NEM vált stratégiát.
 */
export const ENTRY_SHAPES: Record<string, EntryShape> = {
  breakout: breakoutShape,
  orb15: orbShape(15),
  orb30: orbShape(30),
  orb60: orbShape(60),
  "orb15-trend": orbTrendShape(15),
  "orb30-trend": orbTrendShape(30),
  "gap-go": gapGoShape(0.003, 15),
  "vwap-trend": vwapTrendShape,
  "vwap-cross": vwapCrossShape,
  // 156 bar = 2 ülés hosszú trend, a rövid átlag a strategy.momentumSmaPeriod (78 = 1 ülés).
  pullback: pullbackShape(156),
  "tod-open": timeOfDayShape(0, 90),
  "tod-power": timeOfDayShape(300, 390),
  "regime-spy": regimeShape("SPY"),
  // Napszak-ablak rács: a 90 perc önkényes volt, a szélessége is mérendő.
  "tod-30": timeOfDayShape(0, 30),
  "tod-60": timeOfDayShape(0, 60),
  "tod-120": timeOfDayShape(0, 120),
  "tod-150": timeOfDayShape(0, 150),
  "tod-210": timeOfDayShape(0, 210),
  // A délelőtt ELSŐ fél órája nélkül (a nyitó zaj kihagyva).
  "tod-30-120": timeOfDayShape(30, 120),
  // Egymást NEM fedő fél órák: melyik szakasz viszi a hozamot.
  "seg-0-30": timeOfDayShape(0, 30),
  "seg-30-60": timeOfDayShape(30, 60),
  "seg-60-90": timeOfDayShape(60, 90),
  "seg-90-150": timeOfDayShape(90, 150),
  "seg-150-240": timeOfDayShape(150, 240),
  "seg-240-330": timeOfDayShape(240, 330),
  // Placebo-sor: ugyanazok az ablakok, de JEL NÉLKÜL (mindig belép, ha van szabad hely).
  always: alwaysShape,
  "always-0-30": allOf(timeWindowFilter(0, 30), alwaysShape),
  "always-0-60": allOf(timeWindowFilter(0, 60), alwaysShape),
  "always-90-150": allOf(timeWindowFilter(90, 150), alwaysShape),
  "always-240-330": allOf(timeWindowFilter(240, 330), alwaysShape),
  // A két külön-külön robusztus szűrő egymáson.
  "tod90+regime": allOf(timeWindowFilter(0, 90), regimeFilter("SPY"), breakoutShape),
  "tod120+regime": allOf(timeWindowFilter(0, 120), regimeFilter("SPY"), breakoutShape),
  "tod60+regime": allOf(timeWindowFilter(0, 60), regimeFilter("SPY"), breakoutShape),
};

/**
 * Név → alak feloldás az élesnek. Üres vagy ismeretlen névre null (a hívó ilyenkor a
 * beépített jelet használja, és naplózza a hibát) — így egy elgépelt env-változó nem
 * kapcsol ki némán minden belépőt.
 */
export function resolveEntryShape(name: string | undefined): EntryShape | null {
  const key = (name ?? "").trim();
  if (key === "") return null;
  return ENTRY_SHAPES[key] ?? null;
}

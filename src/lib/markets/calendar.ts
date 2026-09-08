/**
 * Piac-nyitvatartás (trading calendar) — több-eszközosztályú.
 *
 * A kripto 0/24 nyitva; a részvény CSAK a szabályos amerikai ülésben (09:30–16:00
 * America/New_York), hétköznap, ünnepnapok nélkül. Ez a különbség a mostani „mindig
 * nyitva" feltételezés miatt kritikus: a részvény-tick zárt piacon NEM dönthet, mert
 * nincs friss ár, és a fill sem valósulna meg.
 *
 * Időzóna: az `Intl.DateTimeFormat` `timeZone: "America/New_York"` opcióját használjuk,
 * hogy a nyári/téli időszámítást (EST/EDT) NE kézzel kelljen számolni — a kézi DST
 * mindig elromlik egy határnapon.
 *
 * Tiszta függvények: az idő injektált (epoch ms), nincs IO.
 */

export type AssetClass = "crypto" | "stock";

/** Egy piac állapota egy adott időpontban. */
export interface MarketSession {
  /** Kereskedhető-e MOST ezen az eszközosztályon. */
  open: boolean;
  /** Ember-olvasható ok — a döntésnaplóba kerül, ha zárt. */
  reason:
    | "crypto-always-open"
    | "regular-session"
    | "weekend"
    | "holiday"
    | "pre-market"
    | "after-hours";
}

/** Az ET (America/New_York) fali-óra bontása egy epoch ms-ből. */
export interface EtParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number;
  /** 0 = vasárnap … 6 = szombat. */
  weekday: number;
}

const ET_TZ = "America/New_York";

const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Egy epoch ms felbontása America/New_York fali-órára. A DST-t az `Intl` intézi —
 * ugyanaz az abszolút pillanat nyáron EDT, télen EST helyi időt ad.
 */
/**
 * Perc-vödrös gyorsítótár az `etParts` elé.
 *
 * Az `Intl.formatToParts` drága, és a jel-számítás gyertyánként többször is hívja: egy
 * 30 papíros, 60 napos intraday backteszt így több tízmillió hívást csinál (mérve
 * ~235 000 hívás/mp, azaz percekben mérhető tiszta `Intl`-idő futásonként).
 *
 * A vödör kulcsa a UTC-perc. Ez pontos: az America/New_York eltolás egész órás, tehát
 * egy UTC-perc mindig pontosan egy ET-percre képződik le — a DST-váltás sem oszt percet
 * ketté. A gyorsítótár csak az `Intl`-hívást spórolja meg, az eredményt nem változtatja.
 */
const ET_PARTS_CACHE = new Map<number, EtParts>();
const ET_PARTS_CACHE_MAX = 200_000;

export function etParts(nowMs: number): EtParts {
  const bucket = Math.floor(nowMs / 60_000);
  const hit = ET_PARTS_CACHE.get(bucket);
  if (hit) return hit;
  const computed = computeEtParts(nowMs);
  if (ET_PARTS_CACHE.size >= ET_PARTS_CACHE_MAX) ET_PARTS_CACHE.clear();
  ET_PARTS_CACHE.set(bucket, computed);
  return computed;
}

function computeEtParts(nowMs: number): EtParts {
  const parts = ET_FORMAT.formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // hour12:false mellett a "24" éjfélt jelenthet — normalizáljuk 0-ra.
  const rawHour = Number(get("hour"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(get("minute")),
    // Ha az Intl váratlan hétköznap-nevet ad, a napot az ET DÁTUMBÓL számoljuk. A régi
    // UTC-fallback néma hibát okozott: ET vasárnap 20:00 UTC-ben már hétfő, tehát a
    // hétvégéből kereskedési nap lett volna.
    weekday:
      WEEKDAY_INDEX[get("weekday")] ??
      new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")))).getUTCDay(),
  };
}

/**
 * US tőzsdei zárva-tartó ünnepnapok (teljes zárás), `YYYY-MM-DD` (ET dátum) formában.
 * 2025–2027, a hivatalos NYSE naptár szerint; a megfigyelt (observed) eltolások benne
 * vannak. Bővíthető. A KORAI ZÁRÁSÚ napok külön listában vannak
 * (`US_MARKET_HALF_DAYS`), mert azok kereskedési napok, csak rövidebbek.
 */
export const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025
  "2025-01-01", // New Year's Day
  "2025-01-20", // MLK Jr. Day
  "2025-02-17", // Washington's Birthday
  "2025-04-18", // Good Friday
  "2025-05-26", // Memorial Day
  "2025-06-19", // Juneteenth
  "2025-07-04", // Independence Day
  "2025-09-01", // Labor Day
  "2025-11-27", // Thanksgiving
  "2025-12-25", // Christmas
  // 2026
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03", // Independence Day (observed, júl. 4 szombat)
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18", // Juneteenth (observed, jún. 19 szombat)
  "2027-07-05", // Independence Day (observed, júl. 4 vasárnap)
  "2027-09-06",
  "2027-11-25",
  "2027-12-24", // Christmas (observed, dec. 25 szombat)
]);

/**
 * KORAI ZÁRÁSÚ (fél-napos) tőzsdei ülések: 09:30–13:00 ET. Kereskedési napok, de három
 * órával rövidebbek.
 *
 * Miért számít: a day-trading ciklus fázisait (belépő-stop, nap végi laposra zárás) a
 * zárásig hátralévő perc vezérli. E lista nélkül a bot fél-napon 13:00 után is
 * `trading` fázisban maradna, ELAVULT áron nyitna pozíciót, és a laposra zárás három
 * órával a valódi záró UTÁN futna — vagyis a pozíció bent ragadna éjszakára.
 *
 * NYSE szabály szerint korai zárás: a hálaadás UTÁNI péntek, és a karácsony előtti nap,
 * ha az önmagában kereskedési nap. (Amikor július 4. hétvégére esik, nincs korai zárás,
 * mert a piac a megfigyelt ünnepen egész nap zárva van.)
 */
export const US_MARKET_HALF_DAYS: ReadonlySet<string> = new Set([
  "2025-07-03", // július 4. előtti nap
  "2025-11-28", // hálaadás utáni péntek
  "2025-12-24", // szenteste
  "2026-11-27", // hálaadás utáni péntek
  "2026-12-24", // szenteste
  "2027-11-26", // hálaadás utáni péntek
]);

/** Igaz, ha az adott ET-nap korai zárású (13:00 ET). */
export function isHalfDay(nowMs: number): boolean {
  return US_MARKET_HALF_DAYS.has(etDateKey(etParts(nowMs)));
}

/** ET dátumkulcs (`YYYY-MM-DD`) egy bontásból. */
export function etDateKey(p: Pick<EtParts, "year" | "month" | "day">): string {
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/** Igaz, ha az adott ET-nap tőzsdei kereskedési nap (nem hétvége, nem ünnep). */
export function isUsTradingDay(nowMs: number): boolean {
  const p = etParts(nowMs);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return !US_MARKET_HOLIDAYS.has(etDateKey(p));
}

// Szabályos ülés: 09:30–16:00 ET, korai zárású napon 09:30–13:00. Percben az éjfél óta.
const SESSION_OPEN_MIN = 9 * 60 + 30;
const SESSION_CLOSE_MIN = 16 * 60;
const HALF_DAY_CLOSE_MIN = 13 * 60;

/** Az adott nap zárási perce ET-ben (korai zárású napon 13:00, egyébként 16:00). */
export function sessionCloseMinute(nowMs: number): number {
  return isHalfDay(nowMs) ? HALF_DAY_CLOSE_MIN : SESSION_CLOSE_MIN;
}

/** Az amerikai részvénypiac ülés-állapota egy időpontban. */
export function usEquitySession(nowMs: number): MarketSession {
  const p = etParts(nowMs);
  if (p.weekday === 0 || p.weekday === 6) return { open: false, reason: "weekend" };
  if (US_MARKET_HOLIDAYS.has(etDateKey(p))) return { open: false, reason: "holiday" };
  const minutes = p.hour * 60 + p.minute;
  if (minutes < SESSION_OPEN_MIN) return { open: false, reason: "pre-market" };
  if (minutes >= sessionCloseMinute(nowMs)) return { open: false, reason: "after-hours" };
  return { open: true, reason: "regular-session" };
}

/**
 * Hány perc van hátra a szabályos ülés zárásáig (16:00 ET). `null`, ha épp nincs ülés.
 * A day-trading sáv ebből tudja, mikor kell laposra zárnia és mikor ne nyisson újat.
 */
export function minutesToSessionClose(nowMs: number): number | null {
  const session = usEquitySession(nowMs);
  if (!session.open) return null;
  const p = etParts(nowMs);
  return sessionCloseMinute(nowMs) - (p.hour * 60 + p.minute);
}

/**
 * Hány perc telt el a szabályos ülés nyitása (09:30 ET) óta. null, ha épp nincs ülés.
 * Az ülés-relatív belépők (opening range, napszak-szűrő) ebből tudják, hol tartunk a napban.
 */
export function minutesFromSessionOpen(nowMs: number): number | null {
  const session = usEquitySession(nowMs);
  if (!session.open) return null;
  const p = etParts(nowMs);
  return p.hour * 60 + p.minute - SESSION_OPEN_MIN;
}

/**
 * Az adott ET-nap ÜLÉS-NYITÁSA (09:30 ET) epoch ms-ban — a napi veszteségkapu
 * referencia-pontja a részvény-sávon. Perces pontosságú.
 *
 * Miért nem naptárból építjük: az ET eltolás évszakfüggő (EST/EDT), és a
 * `Date.parse("...T14:30:00Z")` csak télen esne 09:30 ET-re. A mostani időpontból
 * VISSZAFELÉ számolva viszont az eltolás kiesik. A nap 2:00 ET DST-váltása a nyitás
 * előtt van, tehát a nyitás és a `nowMs` közé nem eshet váltás.
 */
export function sessionOpenMs(nowMs: number): number {
  const p = etParts(nowMs);
  const minutesOfDay = p.hour * 60 + p.minute;
  return Math.floor(nowMs / 60_000) * 60_000 - (minutesOfDay - SESSION_OPEN_MIN) * 60_000;
}

/**
 * Az adott nap ÜLÉS-ZÁRÁSA epoch ms-ban (16:00 ET, fél napon 13:00 ET). `null`, ha az adott
 * nap nem kereskedési nap. A visszaszámláló ebből tudja, meddig tart még a mai ülés.
 *
 * Ugyanaz a visszafelé-számolás, mint a `sessionOpenMs`-nél: az ET-eltolás így kiesik.
 */
export function sessionCloseMs(nowMs: number): number | null {
  if (!isUsTradingDay(nowMs)) return null;
  const p = etParts(nowMs);
  const minutesOfDay = p.hour * 60 + p.minute;
  return Math.floor(nowMs / 60_000) * 60_000 - (minutesOfDay - sessionCloseMinute(nowMs)) * 60_000;
}

/**
 * A KÖVETKEZŐ ülés-nyitás (09:30 ET) epoch ms-ban a mostani időponthoz képest.
 *
 * A „következő" azt jelenti, ami még ELŐTTÜNK van: nyitás előtt az aznapi nyitás, nyitás
 * után (ülés közben vagy zárás után) a soron következő KERESKEDÉSI nap nyitása — a
 * hétvégét és az ünnepnapokat átugorva. A visszaszámláló ebből tudja, mikor ébred a
 * részvény-sáv.
 */
export function nextSessionOpenMs(nowMs: number): number {
  const todayOpen = sessionOpenMs(nowMs);
  if (isUsTradingDay(nowMs) && nowMs < todayOpen) return todayOpen;
  // Legfeljebb 10 nap: a leghosszabb reális szünet (hosszú hétvége ünneppel) is belefér.
  for (let i = 1; i <= 10; i++) {
    const probe = nowMs + i * 24 * 60 * 60 * 1000;
    if (isUsTradingDay(probe)) return sessionOpenMs(probe);
  }
  return todayOpen + 24 * 60 * 60 * 1000;
}

/** A piac állapota eszközosztály szerint. */
export function marketSession(assetClass: AssetClass, nowMs: number): MarketSession {
  if (assetClass === "crypto") return { open: true, reason: "crypto-always-open" };
  return usEquitySession(nowMs);
}

/** Rövid segédfüggvény: kereskedhető-e MOST az eszközosztály. */
export function isMarketOpen(assetClass: AssetClass, nowMs: number): boolean {
  return marketSession(assetClass, nowMs).open;
}

/**
 * Egy NAPI gyertya lezárt-e az adott ET-időben.
 *
 * A `closeTime` aritmetika helyett a NAPTÁRRA támaszkodunk: a napi bar záró pillanata
 * a szabályos ülés vége (16:00 ET), amit a kézi DST helyett a naptár dönt el.
 * Provider-független (Stooq és Yahoo is ezt használja).
 */
export function isDailyBarClosed(dateKey: string, nowMs: number): "closed" | "unclosed" | "future" {
  const todayKey = etDateKey(etParts(nowMs));
  if (dateKey < todayKey) return "closed";
  if (dateKey > todayKey) return "future";
  // Ma: csak akkor lezárt, ha az ülés véget ért.
  return usEquitySession(nowMs).reason === "after-hours" ? "closed" : "unclosed";
}

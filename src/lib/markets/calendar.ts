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
export function etParts(nowMs: number): EtParts {
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
    weekday: WEEKDAY_INDEX[get("weekday")] ?? new Date(nowMs).getUTCDay(),
  };
}

/**
 * US tőzsdei zárva-tartó ünnepnapok (teljes zárás), `YYYY-MM-DD` (ET dátum) formában.
 * 2025–2027, a hivatalos NYSE naptár szerint; a megfigyelt (observed) eltolások benne
 * vannak. Bővíthető — a fél-napos ülések (korai zárás) itt NEM szerepelnek, mert a
 * napi close akkor is létrejön.
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

// Szabályos ülés: 09:30–16:00 ET. Percben az éjfél óta.
const SESSION_OPEN_MIN = 9 * 60 + 30;
const SESSION_CLOSE_MIN = 16 * 60;

/** Az amerikai részvénypiac ülés-állapota egy időpontban. */
export function usEquitySession(nowMs: number): MarketSession {
  const p = etParts(nowMs);
  if (p.weekday === 0 || p.weekday === 6) return { open: false, reason: "weekend" };
  if (US_MARKET_HOLIDAYS.has(etDateKey(p))) return { open: false, reason: "holiday" };
  const minutes = p.hour * 60 + p.minute;
  if (minutes < SESSION_OPEN_MIN) return { open: false, reason: "pre-market" };
  if (minutes >= SESSION_CLOSE_MIN) return { open: false, reason: "after-hours" };
  return { open: true, reason: "regular-session" };
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

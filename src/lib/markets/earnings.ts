/**
 * Gyorsjelentés-naptár (Finnhub) — belépő-tiltás a jelentés napjára.
 *
 * Miért kell day tradinghez: a nap végi laposra zárás miatt az ÉJSZAKAI earnings-gap nem
 * érhet minket, de a jelentés NAPJA intraday is más rezsim (nyitó ugrás, széles spread,
 * whipsaw). A momentum-belépő ilyenkor rendszeresen a csúcsra vásárol. Ezért a jelentő
 * papír aznap KIMARAD az új belépőkből — a meglévő pozíciót a szokásos stop/TP és a nap
 * végi zárás kezeli.
 *
 * Kulcs nélkül (`FINNHUB_API_KEY` hiányzik) minden függvény ÜRES halmazt ad: ilyenkor
 * nincs tiltás, és a ciklus fut tovább. A hiányzó kulcs nem állíthatja meg a kereskedést,
 * de a hiányát a hívó naplózza.
 */

const FINNHUB_BASE = "https://finnhub.io/api/v1";

export interface EarningsEntry {
  symbol: string;
  /** ET-dátum (`YYYY-MM-DD`). */
  date: string;
  /** `bmo` (nyitás előtt), `amc` (zárás után), vagy üres. */
  hour: string;
}

export interface EarningsOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function finnhubConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.FINNHUB_API_KEY);
}

/**
 * A [from, to] ET-dátum-tartomány gyorsjelentései. Hibánál üres lista (fail-open a
 * kereskedésre nézve, de a hívó látja a hibát a naplóban).
 */
export async function fetchEarningsCalendar(
  from: string,
  to: string,
  opts: EarningsOptions = {},
): Promise<EarningsEntry[]> {
  const env = opts.env ?? process.env;
  if (!finnhubConfigured(env)) return [];
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${FINNHUB_BASE}/calendar/earnings?from=${from}&to=${to}&token=${env.FINNHUB_API_KEY}`;
  try {
    const res = await doFetch(url);
    if (!res.ok) {
      console.warn(`[earnings] Finnhub HTTP ${res.status}`);
      return [];
    }
    const d = (await res.json()) as { earningsCalendar?: { symbol?: string; date?: string; hour?: string }[] };
    return (d.earningsCalendar ?? [])
      .filter((e) => e.symbol && e.date)
      .map((e) => ({ symbol: String(e.symbol).toUpperCase(), date: String(e.date), hour: String(e.hour ?? "") }));
  } catch (e) {
    console.warn("[earnings] Finnhub hiba:", e);
    return [];
  }
}

/**
 * Azok a szimbólumok a figyelt körből, amelyek a megadott ET-napon jelentenek (vagy az
 * előző nap zárása UTÁN jelentettek, mert a REAKCIÓ erre a napra esik).
 *
 * Processzenként gyorsítótárazva (`ttlMs`, alap 6 óra): a naptár napközben nem változik,
 * és egy 5 perces ciklus nem hívhatja percenként az API-t.
 */
const calendarCache = new Map<string, { entries: EarningsEntry[]; at: number }>();

export async function symbolsWithEarningsOn(
  dateKey: string,
  previousTradingDateKey: string,
  symbols: string[],
  opts: EarningsOptions & { ttlMs?: number } = {},
): Promise<Set<string>> {
  const env = opts.env ?? process.env;
  const blocked = new Set<string>();
  if (!finnhubConfigured(env) || symbols.length === 0) return blocked;

  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? 6 * 60 * 60 * 1000;
  const cacheKey = `${previousTradingDateKey}:${dateKey}`;
  const hit = calendarCache.get(cacheKey);
  let entries: EarningsEntry[];
  if (hit && now() - hit.at < ttl) {
    entries = hit.entries;
  } else {
    entries = await fetchEarningsCalendar(previousTradingDateKey, dateKey, opts);
    calendarCache.set(cacheKey, { entries, at: now() });
  }

  const watched = new Set(symbols.map((s) => s.toUpperCase()));
  for (const e of entries) {
    if (!watched.has(e.symbol)) continue;
    // Ma jelent (bármely időpont) → ma nincs belépő.
    if (e.date === dateKey) blocked.add(e.symbol);
    // Tegnap zárás UTÁN jelentett → a piaci reakció MA történik.
    else if (e.date === previousTradingDateKey && e.hour === "amc") blocked.add(e.symbol);
  }
  return blocked;
}

/** Teszt-segéd: a naptár-gyorsítótár ürítése. */
export function clearEarningsCache(): void {
  calendarCache.clear();
}

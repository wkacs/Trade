/**
 * Alpaca kliens — NEM adat-forrás, hanem **kereskedési metaadat** és paper-számla.
 *
 * Miért nem innen jön a gyertya: az Alpaca ingyenes adat-szintje kizárólag az **IEX**
 * tape-et adja, ami a teljes forgalom pár százaléka; a nyitás előtt/után gyakran hiányzik
 * bar, és a bar-alak sem a konszolidált piacé. A Yahoo chart konszolidált és mérve
 * ~30 másodperces késésű, ezért a gyertya marad a Yahoo-nál. Amit az Alpaca ad, és amit
 * máshonnan nem kapunk meg hitelesen:
 *
 *  - `fractionable`: kereskedhető-e TÖRT részvény az adott papírra. Enélkül a paper-fill
 *    egész darabra kerekít, és 10 000 USD-n a 2%-os tétel 0 darab SPY-t jelentene.
 *  - `tradable`, `shortable`, `min_order_size`, `price_increment`: a valódi tőzsdei
 *    szabályok, a mi találgatásunk helyett.
 *  - paper-számla állapot (készpénz, PDT-számláló) — a későbbi valódi paper-végrehajtáshoz.
 *
 * Kulcs nélkül minden függvény `null`-t ad (a hívó a konzervatív alapértelmezést használja),
 * és SOHA nem dob — a hiányzó kulcs nem állíthatja meg a kereskedési ciklust.
 */

const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";

export interface AlpacaAsset {
  symbol: string;
  tradable: boolean;
  fractionable: boolean;
  shortable: boolean;
  exchange: string;
  /** Legkisebb rendelhető mennyiség (tört papírnál tipikusan 0,000000001). */
  minOrderSize: string | null;
  /** Mennyiség-lépésköz. */
  minTradeIncrement: string | null;
  /** Ár-lépésköz (tick). */
  priceIncrement: string | null;
}

export interface AlpacaAccount {
  status: string;
  currency: string;
  cash: number;
  equity: number;
  buyingPower: number;
  patternDayTrader: boolean | null;
  daytradeCount: number | null;
}

/** Igaz, ha van Alpaca kulcspár a környezetben. */
export function alpacaConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY);
}

function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  // Alapértelmezés a PAPER végpont. Élesre csak explicit `ALPACA_PAPER=0` kapcsol.
  return (env.ALPACA_PAPER ?? "1").trim() === "0" ? LIVE_BASE : PAPER_BASE;
}

function headers(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID ?? "",
    "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY ?? "",
    accept: "application/json",
  };
}

export interface AlpacaOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** Egy instrumentum kereskedési metaadata. Kulcs nélkül vagy hibánál `null`. */
export async function fetchAlpacaAsset(symbol: string, opts: AlpacaOptions = {}): Promise<AlpacaAsset | null> {
  const env = opts.env ?? process.env;
  if (!alpacaConfigured(env)) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${baseUrl(env)}/v2/assets/${encodeURIComponent(symbol)}`, { headers: headers(env) });
    if (!res.ok) {
      console.warn(`[alpaca] asset ${symbol}: HTTP ${res.status}`);
      return null;
    }
    const d = (await res.json()) as Record<string, unknown>;
    return {
      symbol: String(d.symbol ?? symbol),
      tradable: d.tradable === true,
      fractionable: d.fractionable === true,
      shortable: d.shortable === true,
      exchange: String(d.exchange ?? ""),
      minOrderSize: d.min_order_size == null ? null : String(d.min_order_size),
      minTradeIncrement: d.min_trade_increment == null ? null : String(d.min_trade_increment),
      priceIncrement: d.price_increment == null ? null : String(d.price_increment),
    };
  } catch (e) {
    console.warn(`[alpaca] asset ${symbol} hiba:`, e);
    return null;
  }
}

/** Az Alpaca paper-számla állapota. Kulcs nélkül vagy hibánál `null`. */
export async function fetchAlpacaAccount(opts: AlpacaOptions = {}): Promise<AlpacaAccount | null> {
  const env = opts.env ?? process.env;
  if (!alpacaConfigured(env)) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${baseUrl(env)}/v2/account`, { headers: headers(env) });
    if (!res.ok) {
      console.warn(`[alpaca] account: HTTP ${res.status}`);
      return null;
    }
    const d = (await res.json()) as Record<string, unknown>;
    return {
      status: String(d.status ?? ""),
      currency: String(d.currency ?? "USD"),
      cash: Number(d.cash ?? 0),
      equity: Number(d.equity ?? 0),
      buyingPower: Number(d.buying_power ?? 0),
      patternDayTrader: typeof d.pattern_day_trader === "boolean" ? d.pattern_day_trader : null,
      daytradeCount: typeof d.daytrade_count === "number" ? d.daytrade_count : null,
    };
  } catch (e) {
    console.warn("[alpaca] account hiba:", e);
    return null;
  }
}

/**
 * Kereskedhető-e TÖRT részvény MINDEN felsorolt papírra.
 *
 * Szándékosan „mind vagy semmi": a paper-fill egyetlen szűrő-készlettel dolgozik egy
 * cikluson belül, és a konzervatív irány az egész darab. Ha egyetlen papír sem
 * fractionable — vagy nincs Alpaca kulcs, vagy hibázik a lekérés —, marad az egész lot.
 *
 * A választ processzenként gyorsítótárazzuk (`ttlMs`, alap 12 óra): az asset-metaadat
 * ritkán változik, és egy 5 perces ciklus nem terhelheti feleslegesen az API-t.
 */
const assetCache = new Map<string, { asset: AlpacaAsset | null; at: number }>();

export async function allFractionable(
  symbols: string[],
  opts: AlpacaOptions & { now?: () => number; ttlMs?: number } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (!alpacaConfigured(env) || symbols.length === 0) return false;
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? 12 * 60 * 60 * 1000;

  for (const symbol of symbols) {
    const hit = assetCache.get(symbol);
    let asset: AlpacaAsset | null;
    if (hit && now() - hit.at < ttl) {
      asset = hit.asset;
    } else {
      asset = await fetchAlpacaAsset(symbol, opts);
      // Csak SIKERES lekérés kerül a gyorsítótárba (audit 3. pont). Egy átmeneti 500-as
      // válasz különben a TTL végéig „nem fractionable" állapotba fagyasztaná a papírt,
      // és a hiba forrása (a hálózat) láthatatlan maradna. Ha van korábbi hiteles adat,
      // az marad érvényben; ha nincs, a mostani kör konzervatívan egész lotot használ.
      if (asset) assetCache.set(symbol, { asset, at: now() });
      else if (hit) asset = hit.asset;
    }
    if (!asset || !asset.tradable || !asset.fractionable) return false;
  }
  return true;
}

/** Teszt-segéd: a metaadat-gyorsítótár ürítése. */
export function clearAlpacaAssetCache(): void {
  assetCache.clear();
}

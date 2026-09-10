import type { DataPoint } from "@/lib/types";

/**
 * A FELÜLET ártáblája — a dashboard ebből mutat árat, 24 órás változást és P&L-t.
 *
 * Külön modul, mert nem végrehajtási adat: a KÖTÉS soha nem innen dolgozik, hanem a
 * `market/quotes.ts` külön, rövid időkorlátos bid/ask lekéréséből. Itt a cél az, hogy a
 * felület SOSE maradjon ár nélkül, amíg bármelyik forrás ad árat.
 */

/** Honnan származik a megjelenített ár. A felület ebből tudja, mennyire friss. */
export type PriceSource = "coingecko" | "binance";

export interface PriceView {
  usd: number;
  change24hPct: number;
  source: PriceSource;
}

/** Ennyi ÓRÁS gyertyával korábbi záró adja a 24 órás változás alapját. */
const HOURS_24 = 24;

/**
 * Ártábla a gyűjtött adatpontokból, forrás-prioritással.
 *
 * ELSŐDLEGES a CoinGecko: valódi spot ár és valódi gördülő 24 órás változás. A hiánya
 * viszont NEM hagyhatja ár nélkül a felületet.
 *
 * Miért: a CoinGecko ingyenes tierje megosztott felhő-IP-ről rendszeresen 429-cel válaszol.
 * A korábbi kód ilyenkor ÜRES ártáblát adott, a dashboard pedig belépési árra esett vissza
 * — a nyitott pozíció P&L-százaléka napokig moccanatlan maradt, holott a bot maga (a
 * Binance lezárt órás gyertyáiból) végig látta az árat. Ugyanaz az adat itt is rendelkezésre
 * áll, ezért a hiányzó coinokat abból pótoljuk, MEGNEVEZVE a forrást.
 *
 * A tartalék ár legfeljebb egy órával a valós idő mögött van (az utolsó LEZÁRT gyertya
 * zárója), a „24h változás" pedig a 24 gyertyával korábbi záróhoz mért eltérés. Ez nem
 * azonos a CoinGecko gördülő ablakával, de ugyanazt mondja, és mérhető.
 */
export function pricesFromEvents(events: DataPoint[]): Record<string, PriceView> {
  const prices: Record<string, PriceView> = {};
  for (const e of events) {
    if (e.source === "coingecko" && e.kind === "price" && e.price && Number.isFinite(e.price.usd)) {
      prices[e.symbol] = { usd: e.price.usd, change24hPct: e.price.change24hPct, source: "coingecko" };
    }
  }
  for (const [symbol, fallback] of Object.entries(binancePrices(events))) {
    if (!prices[symbol]) prices[symbol] = fallback;
  }
  return prices;
}

/** Tartalék ártábla a Binance LEZÁRT órás gyertyáiból — ugyanabból a sorozatból, amiből a tick is dolgozik. */
export function binancePrices(events: DataPoint[]): Record<string, PriceView> {
  const bySymbol = new Map<string, DataPoint[]>();
  for (const e of events) {
    if (e.source !== "binance" || e.kind !== "price" || !e.price) continue;
    const list = bySymbol.get(e.symbol);
    if (list) list.push(e);
    else bySymbol.set(e.symbol, [e]);
  }

  const out: Record<string, PriceView> = {};
  for (const [symbol, points] of bySymbol) {
    const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
    const last = sorted[sorted.length - 1];
    if (!last?.price || !Number.isFinite(last.price.usd)) continue;
    const ref = sorted[sorted.length - 1 - HOURS_24]?.price?.usd;
    // Referencia nélkül a változás nem kitalált szám: 0-ként megy tovább, és a `source`
    // mezőből látszik, hogy tartalék adatról van szó.
    const change24hPct = ref !== undefined && ref > 0 ? ((last.price.usd - ref) / ref) * 100 : 0;
    out[symbol] = { usd: last.price.usd, change24hPct, source: "binance" };
  }
  return out;
}

/**
 * Instrumentum-katalógus (market registry) — a kereskedhető eszközök EGYETLEN
 * igazságforrása, eszközosztály-tudatosan.
 *
 * Miért kell: a `COIN_UNIVERSE` ma kripto-only, és ~30 helyről hivatkozott. Ez a
 * registry NEM cseréli le — abból SZÁRMAZTATJA a kripto instrumentumokat, és mellé
 * adja a részvény-katalógust. Így a több-piacos kód egy helyről kérdezi le, mi micsoda
 * (asset class, quote, adatprovider), a meglévő kripto-út pedig változatlan marad.
 *
 * FONTOS a nem-töréshez: a KATALÓGUS bővül, de az AKTÍV univerzum env-vezérelt, és
 * alapból PONTOSAN a mai kripto-kosár. Új instrumentum csak explicit env-flaggel él —
 * a futó tick és a tesztek viselkedése nem változik.
 */

import { COIN_UNIVERSE } from "@/lib/config";
import type { AssetClass } from "./calendar";

export type { AssetClass };

/** Melyik adatprovider tölti az instrumentum gyertyáit. */
export type DataProvider = "binance" | "stooq";

/** Egy kereskedhető instrumentum leírója. */
export interface Instrument {
  /** Belső, egyedi szimbólum (kripto: "BTC"; részvény: "AAPL"). */
  symbol: string;
  assetClass: AssetClass;
  /** Elszámoló pénznem (kripto: "USDT"; részvény: "USD"). */
  quote: string;
  dataProvider: DataProvider;
  /** Ember-olvasható név a dashboardhoz. */
  displayName: string;
  /**
   * A provider-specifikus lekérdező azonosító. Kriptónál a base szimbólum (a pár a
   * quote-tal áll össze, pl. BTC+USDT); Stooq-nál a teljes ticker (pl. "aapl.us").
   */
  providerSymbol: string;
}

/** A kripto instrumentumok a meglévő COIN_UNIVERSE-ből származnak (nincs duplikáció). */
const CRYPTO_INSTRUMENTS: Instrument[] = COIN_UNIVERSE.map((symbol) => ({
  symbol,
  assetClass: "crypto",
  quote: "USDT",
  dataProvider: "binance",
  displayName: symbol,
  providerSymbol: symbol,
}));

/**
 * Extra kripto-katalógus (a COIN_UNIVERSE-en túl). Csak akkor lesz AKTÍV, ha a
 * `MARKETS_EXTRA_CRYPTO` env explicit felsorolja őket. Mindegyikhez létezik
 * `<symbol>USDT` pár a Binance-en.
 */
const EXTRA_CRYPTO_CATALOG: Instrument[] = [
  { symbol: "BNB", assetClass: "crypto", quote: "USDT", dataProvider: "binance", displayName: "BNB", providerSymbol: "BNB" },
  { symbol: "XRP", assetClass: "crypto", quote: "USDT", dataProvider: "binance", displayName: "XRP", providerSymbol: "XRP" },
  { symbol: "ADA", assetClass: "crypto", quote: "USDT", dataProvider: "binance", displayName: "Cardano", providerSymbol: "ADA" },
  { symbol: "AVAX", assetClass: "crypto", quote: "USDT", dataProvider: "binance", displayName: "Avalanche", providerSymbol: "AVAX" },
  { symbol: "LINK", assetClass: "crypto", quote: "USDT", dataProvider: "binance", displayName: "Chainlink", providerSymbol: "LINK" },
];

/**
 * Részvény-katalógus. Csak akkor AKTÍV, ha `MARKETS_ENABLE_STOCKS` igaz. Napi gyertyán,
 * Stooq adatprovider (`<ticker>.us`), USD quote.
 */
const STOCK_CATALOG: Instrument[] = [
  { symbol: "AAPL", assetClass: "stock", quote: "USD", dataProvider: "stooq", displayName: "Apple", providerSymbol: "aapl.us" },
  { symbol: "MSFT", assetClass: "stock", quote: "USD", dataProvider: "stooq", displayName: "Microsoft", providerSymbol: "msft.us" },
  { symbol: "NVDA", assetClass: "stock", quote: "USD", dataProvider: "stooq", displayName: "NVIDIA", providerSymbol: "nvda.us" },
  { symbol: "SPY", assetClass: "stock", quote: "USD", dataProvider: "stooq", displayName: "S&P 500 ETF", providerSymbol: "spy.us" },
];

/** A teljes katalógus (mindaz, amit ISMERÜNK — nem feltétlenül aktív). */
export const INSTRUMENT_CATALOG: readonly Instrument[] = [
  ...CRYPTO_INSTRUMENTS,
  ...EXTRA_CRYPTO_CATALOG,
  ...STOCK_CATALOG,
];

/** Egy vesszős env-lista normalizálása nagybetűs szimbólumokra. */
function parseSymbolList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

/** Env-forrás (injektálható a teszteléshez). */
export interface MarketEnv {
  MARKETS_ENABLE_STOCKS?: string;
  MARKETS_EXTRA_CRYPTO?: string;
  // Index-szignatúra, hogy a `process.env` (ProcessEnv) strukturálisan illeszkedjen.
  [key: string]: string | undefined;
}

/**
 * Az AKTÍV instrumentumok az adott env mellett.
 *
 * - A mai kripto-kosár (COIN_UNIVERSE) MINDIG aktív → a runtime alapból nem változik.
 * - `MARKETS_EXTRA_CRYPTO=BNB,XRP` hozzávesz a katalógusból egyezőket.
 * - `MARKETS_ENABLE_STOCKS=1` (vagy "true") bekapcsolja a teljes részvény-katalógust.
 *
 * Ismeretlen szimbólumot CSENDBEN kihagy (a katalógus a szűrő) — nincs futásidejű meglepetés.
 */
export function activeInstruments(env: MarketEnv = process.env): Instrument[] {
  const active: Instrument[] = [...CRYPTO_INSTRUMENTS];

  const extra = new Set(parseSymbolList(env.MARKETS_EXTRA_CRYPTO));
  if (extra.size > 0) {
    for (const inst of EXTRA_CRYPTO_CATALOG) {
      if (extra.has(inst.symbol)) active.push(inst);
    }
  }

  const flag = (env.MARKETS_ENABLE_STOCKS ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") {
    active.push(...STOCK_CATALOG);
  }

  return active;
}

/** Az aktív instrumentumok egy eszközosztályból. */
export function activeByClass(assetClass: AssetClass, env: MarketEnv = process.env): Instrument[] {
  return activeInstruments(env).filter((i) => i.assetClass === assetClass);
}

/** Instrumentum keresése belső szimbólumból (a teljes katalógusból). */
export function findInstrument(symbol: string): Instrument | undefined {
  const upper = symbol.toUpperCase();
  return INSTRUMENT_CATALOG.find((i) => i.symbol === upper);
}

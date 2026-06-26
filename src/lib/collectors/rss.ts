import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

export interface RSSSource {
  name: string;
  url: string;
  /** Alap szimbólum, ha a címből nem detektálható coin (általános piaci hír → pl. "CRYPTO"). */
  symbol: string;
}

/**
 * A coin-kosár kulcsszavai a cím-alapú szimbólum-detektáláshoz. Szóhatárral, hogy
 * a "sol" ne ragadjon be a "solar"/"console" szavakba. Bővítés: új coinnál ide egy sor.
 */
const COIN_KEYWORDS: { symbol: string; re: RegExp }[] = [
  { symbol: "BTC", re: /\b(btc|bitcoin)\b/i },
  { symbol: "ETH", re: /\b(eth|ethereum|ether)\b/i },
  { symbol: "SOL", re: /\b(sol|solana)\b/i },
];

/** A cikk címéből kitalálja a coint; ha egyik kulcsszó sem talál, a forrás alap-szimbóluma. */
function detectSymbol(title: string, fallback: string): string {
  for (const { symbol, re } of COIN_KEYWORDS) {
    if (re.test(title)) return symbol;
  }
  return fallback;
}

/** RSS <title> kibontása: CDATA-burok és felesleges whitespace eltávolítása. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .trim();
}

/**
 * Legális RSS scrape — csak olyan feedeket használjunk, amik ezt megengedik
 * (pl. CoinDesk, Cointelegraph publikus RSS). Lásd spec §3.1.
 * Egyszerű regex-parsolás (felesleges függőség nélkül); a címből coin-szimbólumot detektál.
 */
export class RSSCollector implements DataCollector {
  name = "rss";
  constructor(private sources: RSSSource[]) {}

  async collect(): Promise<DataPoint[]> {
    const ts = Date.now();
    const out: DataPoint[] = [];
    for (const src of this.sources) {
      try {
        const res = await fetch(src.url);
        if (!res.ok) continue;
        const xml = await res.text();
        const items = Array.from(
          xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/g),
        );
        for (const m of items) {
          const title = cleanTitle(m[1]);
          out.push({
            source: "rss",
            symbol: detectSymbol(title, src.symbol),
            timestamp: ts,
            kind: "rss",
            rss: { title, url: m[2].trim(), source: src.name },
          });
        }
      } catch (e) {
        console.error("[RSS]", src.name, e);
      }
    }
    return out;
  }
}

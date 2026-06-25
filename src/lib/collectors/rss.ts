import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

export interface RSSSource {
  name: string;
  url: string;
  /** Mely coinhoz rendeljük a cikkeket (ha a feed vegyes). */
  symbol: string;
}

/**
 * Legális RSS scrape — csak olyan feedeket használjunk, amik ezt megengedik
 * (pl. CoinDesk, BTC.com publikus RSS). Lásd spec §3.1.
 * Egyszerű regex-parsolás (felesleges függőség nélkül).
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
        const items = xml.matchAll(
          /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>/g,
        );
        for (const m of items) {
          out.push({
            source: "rss",
            symbol: src.symbol,
            timestamp: ts,
            kind: "rss",
            rss: { title: m[1].trim(), url: m[2].trim(), source: src.name },
          });
        }
      } catch (e) {
        console.error("[RSS]", src.name, e);
      }
    }
    return out;
  }
}

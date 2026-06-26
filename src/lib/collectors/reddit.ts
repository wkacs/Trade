import type { DataPoint } from "@/lib/types";
import type { DataCollector } from "./base";

export interface RedditSource {
  /** Subreddit név "r/" nélkül (pl. "CryptoCurrency"). */
  subreddit: string;
  /** Rendezés: hot / top / new. */
  sort: "hot" | "top" | "new";
}

const UA = "ai-crypto-trader/0.1 (personal research)";

/** Coin-kulcsszavak a poszt címéből történő szimbólum-detektáláshoz (mint az RSS-nél). */
const COIN_KEYWORDS: { symbol: string; re: RegExp }[] = [
  { symbol: "BTC", re: /\b(btc|bitcoin)\b/i },
  { symbol: "ETH", re: /\b(eth|ethereum|ether)\b/i },
  { symbol: "SOL", re: /\b(sol|solana)\b/i },
];

function detectSymbol(title: string, fallback: string): string {
  for (const { symbol, re } of COIN_KEYWORDS) {
    if (re.test(title)) return symbol;
  }
  return fallback;
}

/**
 * Reddit közösségi hangulat az official OAuth API-n keresztül (application-only,
 * client_credentials grant). A Reddit a kulcs NÉLKÜLI publikus JSON-t mára 403-mal
 * tiltja, ezért regisztrált app kell (ingyenes: reddit.com/prefs/apps → "script"/"web").
 * A poszt címéből coin-szimbólumot detektál; a score = figyelem-jel. Lásd spec §3.1.
 *
 * Kulcs-gate: az engine csak akkor indítja, ha REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET
 * be van állítva. Token cache-elve (expires_in alapján).
 */
export class RedditCollector implements DataCollector {
  name = "reddit";
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private sources: RedditSource[],
    private limit = 15,
  ) {}

  private async getToken(): Promise<string | null> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      console.error("[Reddit] token HTTP", res.status);
      return null;
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    this.token = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
    return this.token;
  }

  async collect(): Promise<DataPoint[]> {
    const token = await this.getToken();
    if (!token) return [];

    const ts = Date.now();
    const out: DataPoint[] = [];
    for (const src of this.sources) {
      try {
        const url = `https://oauth.reddit.com/r/${src.subreddit}/${src.sort}?limit=${this.limit}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
        });
        if (!res.ok) {
          console.error("[Reddit] HTTP", res.status, src.subreddit);
          continue;
        }
        const data = (await res.json()) as {
          data?: { children?: { data?: { title?: string; score?: number } }[] };
        };
        for (const child of data.data?.children ?? []) {
          const p = child.data;
          if (!p?.title) continue;
          out.push({
            source: "reddit",
            symbol: detectSymbol(p.title, "CRYPTO"),
            timestamp: ts,
            kind: "social",
            social: { title: p.title, score: p.score ?? 0, subreddit: src.subreddit },
          });
        }
      } catch (e) {
        console.error("[Reddit]", src.subreddit, e);
      }
    }
    return out;
  }
}

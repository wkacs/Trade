import { describe, it, expect, vi, beforeEach } from "vitest";
import { RSSCollector } from "@/lib/collectors/rss";

describe("RSSCollector", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("RSS XML-t DataPoint-tá alakít", async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>BTC rally</title><link>https://coindesk.com/1</link></item>
      <item><title>ETH news</title><link>https://coindesk.com/2</link></item>
    </channel></rss>`;
    (global.fetch as any).mockResolvedValue({ ok: true, text: async () => xml });
    const c = new RSSCollector([{ name: "CoinDesk", url: "https://coindesk.com/rss", symbol: "BTC" }]);
    const r = await c.collect();
    expect(r).toHaveLength(2);
    expect(r[0].rss?.source).toBe("CoinDesk");
    expect(r[0].symbol).toBe("BTC");
    expect(r[0].rss?.title).toBe("BTC rally");
  });

  it("feed hiba esetén üres listát ad (nem dob)", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 404 });
    const c = new RSSCollector([{ name: "DeadFeed", url: "https://dead.example/rss", symbol: "BTC" }]);
    const r = await c.collect();
    expect(r).toEqual([]);
  });
});

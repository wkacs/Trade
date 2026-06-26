import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedditCollector } from "@/lib/collectors/reddit";

describe("RedditCollector", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("OAuth token után posztokat social DataPoint-tá alakít, címből coint detektál", async () => {
    const fetchMock = vi
      .fn()
      // 1) token endpoint
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "tok", expires_in: 3600 }),
      })
      // 2) subreddit adat
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            children: [
              { data: { title: "Bitcoin to the moon", score: 1200 } },
              { data: { title: "General market discussion thread", score: 50 } },
            ],
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const c = new RedditCollector("id", "secret", [{ subreddit: "CryptoCurrency", sort: "hot" }]);
    const r = await c.collect();

    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ source: "reddit", symbol: "BTC", kind: "social" });
    expect(r[0].social).toEqual({ title: "Bitcoin to the moon", score: 1200, subreddit: "CryptoCurrency" });
    expect(r[1].symbol).toBe("CRYPTO"); // nincs coin a címben → általános
    // az első hívás a token-endpoint
    expect(fetchMock.mock.calls[0][0]).toContain("access_token");
  });

  it("token hiba esetén üres listát ad (nem dob)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    const c = new RedditCollector("id", "secret", [{ subreddit: "Bitcoin", sort: "hot" }]);
    const r = await c.collect();
    expect(r).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  finnhubConfigured,
  fetchEarningsCalendar,
  symbolsWithEarningsOn,
  clearEarningsCache,
} from "@/lib/markets/earnings";

const env = { FINNHUB_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;

const calendar = (rows: { symbol: string; date: string; hour?: string }[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ earningsCalendar: rows }),
});

beforeEach(() => clearEarningsCache());

describe("markets/earnings", () => {
  it("kulcs nélkül üres (nincs tiltás, a ciklus fut tovább)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(finnhubConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(await fetchEarningsCalendar("2026-09-01", "2026-09-02", { env: {} as NodeJS.ProcessEnv, fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("HTTP-hibánál üres lista (fail-open a kereskedésre)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchEarningsCalendar("2026-09-01", "2026-09-02", { env, fetchImpl })).toEqual([]);
  });

  it("a MAI jelentőt tiltja, a nem figyelt papírt nem", async () => {
    const fetchImpl = vi.fn(async () =>
      calendar([
        { symbol: "aapl", date: "2026-09-08", hour: "amc" },
        { symbol: "ZZZZ", date: "2026-09-08", hour: "bmo" },
      ]),
    ) as unknown as typeof fetch;
    const blocked = await symbolsWithEarningsOn("2026-09-08", "2026-09-04", ["AAPL", "NVDA"], { env, fetchImpl });
    expect([...blocked]).toEqual(["AAPL"]);
  });

  it("az ELŐZŐ kereskedési nap ZÁRÁS UTÁNI jelentése MA is tilt (a reakció ma van)", async () => {
    const fetchImpl = vi.fn(async () =>
      calendar([
        { symbol: "NVDA", date: "2026-09-04", hour: "amc" },
        { symbol: "MSFT", date: "2026-09-04", hour: "bmo" },
      ]),
    ) as unknown as typeof fetch;
    const blocked = await symbolsWithEarningsOn("2026-09-08", "2026-09-04", ["NVDA", "MSFT"], { env, fetchImpl });
    expect([...blocked]).toEqual(["NVDA"]); // az előző nap NYITÁS előtti jelentés már lereagálva
  });

  it("gyorsítótáraz: ugyanarra a napra nem hív újra", async () => {
    const fetchImpl = vi.fn(async () => calendar([{ symbol: "AAPL", date: "2026-09-08" }])) as unknown as typeof fetch;
    const now = () => 5_000_000;
    await symbolsWithEarningsOn("2026-09-08", "2026-09-04", ["AAPL"], { env, fetchImpl, now });
    await symbolsWithEarningsOn("2026-09-08", "2026-09-04", ["AAPL"], { env, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

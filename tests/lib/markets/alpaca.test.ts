import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  alpacaConfigured,
  fetchAlpacaAsset,
  fetchAlpacaAccount,
  allFractionable,
  clearAlpacaAssetCache,
} from "@/lib/markets/alpaca";

const env = { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" } as unknown as NodeJS.ProcessEnv;

const assetJson = (over: Record<string, unknown> = {}) => ({
  symbol: "NVDA",
  exchange: "NASDAQ",
  tradable: true,
  fractionable: true,
  shortable: true,
  min_order_size: null,
  min_trade_increment: null,
  price_increment: null,
  ...over,
});

beforeEach(() => clearAlpacaAssetCache());

describe("markets/alpaca – konfiguráció", () => {
  it("kulcs nélkül nincs konfigurálva, és a lekérés null-t ad (nem dob)", async () => {
    const empty = {} as NodeJS.ProcessEnv;
    expect(alpacaConfigured(empty)).toBe(false);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await fetchAlpacaAsset("NVDA", { env: empty, fetchImpl })).toBeNull();
    expect(await fetchAlpacaAccount({ env: empty, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("alapból a PAPER végpontot hívja", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => assetJson() })) as unknown as typeof fetch;
    await fetchAlpacaAsset("NVDA", { env, fetchImpl });
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("paper-api.alpaca.markets");
    expect(url).toContain("/v2/assets/NVDA");
  });

  it("ALPACA_PAPER=0 esetén az éles végpontot hívja", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => assetJson() })) as unknown as typeof fetch;
    await fetchAlpacaAsset("NVDA", { env: { ...env, ALPACA_PAPER: "0" } as NodeJS.ProcessEnv, fetchImpl });
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("https://api.alpaca.markets");
  });
});

describe("markets/alpaca – allFractionable", () => {
  it("igaz, ha MINDEN papír tradable és fractionable", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => assetJson() })) as unknown as typeof fetch;
    expect(await allFractionable(["NVDA", "SPY"], { env, fetchImpl })).toBe(true);
  });

  it("hamis, ha akár EGY papír nem fractionable (konzervatív irány)", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => assetJson(call++ === 1 ? { fractionable: false } : {}),
    })) as unknown as typeof fetch;
    expect(await allFractionable(["NVDA", "XYZ"], { env, fetchImpl })).toBe(false);
  });

  it("hamis, ha a lekérés hibázik (nem tippelünk tört lotra)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await allFractionable(["NVDA"], { env, fetchImpl })).toBe(false);
  });

  it("gyorsítótáraz: ugyanarra a papírra nem hív újra a TTL-en belül", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => assetJson() })) as unknown as typeof fetch;
    const now = () => 1_000_000;
    await allFractionable(["NVDA"], { env, fetchImpl, now });
    await allFractionable(["NVDA"], { env, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a TTL lejárta után újra lekér", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => assetJson() })) as unknown as typeof fetch;
    let t = 1_000_000;
    await allFractionable(["NVDA"], { env, fetchImpl, now: () => t, ttlMs: 1000 });
    t += 2000;
    await allFractionable(["NVDA"], { env, fetchImpl, now: () => t, ttlMs: 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("markets/alpaca – számla", () => {
  it("a paper-számla mezőit számmá alakítja", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ACTIVE",
        currency: "USD",
        cash: "100000",
        equity: "100000",
        buying_power: "400000",
        pattern_day_trader: false,
        daytrade_count: 2,
      }),
    })) as unknown as typeof fetch;
    const acc = await fetchAlpacaAccount({ env, fetchImpl });
    expect(acc).toMatchObject({ status: "ACTIVE", cash: 100000, equity: 100000, patternDayTrader: false, daytradeCount: 2 });
  });
});

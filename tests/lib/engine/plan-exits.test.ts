import { describe, it, expect } from "vitest";
import { planExits, exitPositionsFromLedger, stopCandidate, type ExitPosition } from "@/lib/engine/plan-exits";
import { DEFAULT_STRATEGY } from "@/lib/strategy/config";
import { makeQuote, type Quote } from "@/lib/market/quotes";

const NOW = 1_700_000_000_000;

const quote = (symbol: string, bid: string, ask = bid, receivedAt = NOW): Quote =>
  makeQuote(symbol, bid, ask, receivedAt, "binance-book")!;

const position = (over: Partial<ExitPosition> = {}): ExitPosition => ({
  symbol: "BTC",
  qty: "0.001",
  entryPrice: "60000",
  stopPrice: "57000",
  ...over,
});

const plan = (positions: ExitPosition[], quotes: Record<string, Quote>, nowMs = NOW, maxAge = 10_000) =>
  planExits({ positions, quotes, nowMs, maxQuoteAgeMs: maxAge }, DEFAULT_STRATEGY);

describe("planExits — közös kilépés-tervező (T21)", () => {
  it("stop-loss: a megfigyelt bid a stop alatt → TELJES pozíció eladása", () => {
    const p = plan([position()], { BTC: quote("BTC", "56000") });
    expect(p.exits).toHaveLength(1);
    expect(p.exits[0]).toMatchObject({ symbol: "BTC", kind: "stop-loss", baseQty: "0.001" });
    expect(p.exits[0].observedPrice).toBe("56000");
  });

  it("take-profit: +10% felett a config szerinti frakció", () => {
    const p = plan([position({ stopPrice: "50000" })], { BTC: quote("BTC", "67000") });
    expect(p.exits[0].kind).toBe("take-profit");
    // takeProfitFraction 1.0 → teljes pozíció
    expect(p.exits[0].baseQty).toBe("0.001");
  });

  it("a stop ELSŐBBSÉGET élvez ugyanabban a ciklusban", () => {
    // Az ár a stop alatt van, de a TP szint felett is lehetne — a stop nyer.
    const p = plan([position({ entryPrice: "50000", stopPrice: "60000" })], { BTC: quote("BTC", "58000") });
    expect(p.exits[0].kind).toBe("stop-loss");
  });

  it("SOHA nem tervez BUY-t", () => {
    const p = plan([position()], { BTC: quote("BTC", "56000") });
    for (const e of p.exits) expect(["stop-loss", "take-profit"]).toContain(e.kind);
    expect(JSON.stringify(p)).not.toContain('"BUY"');
  });

  it("ELAVULT quote-ra NINCS kilépés, és ez látszik", () => {
    const p = plan([position()], { BTC: quote("BTC", "56000", "56000", NOW - 30_000) });
    expect(p.exits).toHaveLength(0);
    expect(p.skipped[0]).toMatchObject({ symbol: "BTC", reason: "stale_quote" });
    expect(p.skipped[0].ageMs).toBe(30_000);
  });

  it("hiányzó quote-ra sincs kilépés", () => {
    const p = plan([position()], {});
    expect(p.exits).toHaveLength(0);
    expect(p.skipped[0].reason).toBe("missing_quote");
  });

  it("időközben lezárt (nulla) pozícióra nincs terv", () => {
    const p = plan([position({ qty: "0" })], { BTC: quote("BTC", "56000") });
    expect(p.exits).toHaveLength(0);
    expect(p.skipped[0].reason).toBe("zero_position");
  });

  it("hiányzó belépési ár mellett nincs terv (nincs kitalált TP-szint)", () => {
    const p = plan([position({ entryPrice: "0" })], { BTC: quote("BTC", "56000") });
    expect(p.exits).toHaveLength(0);
    expect(p.skipped[0].reason).toBe("no_entry_price");
  });

  it("a MÁR beküldött kilépésre nem tervez újat (nincs dupla SELL)", () => {
    const p = planExits(
      {
        positions: [position()],
        quotes: { BTC: quote("BTC", "56000") },
        nowMs: NOW,
        maxQuoteAgeMs: 10_000,
        inFlightSymbols: ["BTC"],
      },
      DEFAULT_STRATEGY,
    );
    expect(p.exits).toHaveLength(0);
    expect(p.skipped).toHaveLength(0);
  });

  it("trailing ratchet: a stop felfelé kúszik, lefelé SOHA", () => {
    const up = plan([position({ stopPrice: "57000" })], { BTC: quote("BTC", "70000") });
    expect(up.stopUpdates).toHaveLength(1);
    expect(Number(up.stopUpdates[0].newStop)).toBeCloseTo(70000 * 0.95, 6);

    const down = plan([position({ stopPrice: "69000" })], { BTC: quote("BTC", "70000") });
    // 70000*0.95 = 66500 < 69000 → nincs frissítés.
    expect(down.stopUpdates).toHaveLength(0);
  });

  it("stop nélküli pozíció kap első stopot", () => {
    const p = plan([position({ stopPrice: null })], { BTC: quote("BTC", "70000") });
    expect(p.stopUpdates).toHaveLength(1);
    expect(p.stopUpdates[0].previousStop).toBeNull();
  });

  it("több pozíciót egyszerre tervez, egymástól függetlenül", () => {
    const p = plan(
      [position(), position({ symbol: "ETH", qty: "1", entryPrice: "3000", stopPrice: "2850" })],
      { BTC: quote("BTC", "56000"), ETH: quote("ETH", "3100") },
    );
    expect(p.exits.map((e) => e.symbol)).toEqual(["BTC"]);
    // A BTC ára esett (56000), a ratchet ezért NEM mozdul; az ETH ára emelkedett → frissül.
    expect(p.stopUpdates.map((s) => s.symbol)).toEqual(["ETH"]);
  });
});

describe("segédek", () => {
  it("exitPositionsFromLedger a bekerülési értékből számol belépési árat", () => {
    const out = exitPositionsFromLedger({
      BTC: { symbol: "BTC", qty: "0.002", costBasisQuote: "120", stopPrice: "57000" },
      ETH: { symbol: "ETH", qty: "0", costBasisQuote: "0", stopPrice: null },
    });
    expect(out).toHaveLength(1);
    expect(out[0].entryPrice).toBe("60000");
  });

  it("stopCandidate ATR módban az ATR-távolságot használja", () => {
    const atrCfg = { ...DEFAULT_STRATEGY, stopMode: "atr" as const, atrMult: 2 };
    expect(stopCandidate("100", "5", atrCfg)).toBe("90");
    // fix módban a százalékos távolság
    expect(stopCandidate("100", "5", DEFAULT_STRATEGY)).toBe("95");
  });
});

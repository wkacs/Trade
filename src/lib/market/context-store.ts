import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { DataPoint } from "@/lib/types";

/**
 * A piaci kontextus-pillanatkép mentése (2026-09-06).
 *
 * A Binance a derivatíva-adatból csak ~21-30 napot ad vissza, ezért az f3 ML-kísérlet
 * nem taníthatott rá. Ez a réteg a SAJÁT történetünket építi: óránként egy sor
 * coinonként. Ami ma nincs elmentve, az három hónap múlva sem lesz meg.
 */
export interface MarketContextRow {
  ts: Date;
  symbol: string;
  fundingRatePct: number | null;
  openInterestBase: number | null;
  openInterestUsd: number | null;
  openInterestChange1hPct: number | null;
  takerBuySellRatio: number | null;
  longShortAccountRatio: number | null;
  premiumPct: number | null;
}

const HOUR_MS = 3_600_000;

/** Az órára kerekített időbélyeg — óránként EGY sor coinonként. */
export function hourBucket(ms: number): Date {
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
}

/**
 * Adatpontokból kontextus-sorok. Tiszta függvény, nincs IO.
 *
 * Csak azok a coinok kapnak sort, amelyekre VAN legalább egy mező. Üres sort nem írunk:
 * a csupa-null rekord a későbbi tanításban indokolatlanul hígítaná a mintát.
 */
export function contextRowsFromEvents(events: DataPoint[], nowMs: number): MarketContextRow[] {
  const ts = hourBucket(nowMs);
  const bySymbol = new Map<string, MarketContextRow>();

  const row = (symbol: string): MarketContextRow => {
    const existing = bySymbol.get(symbol);
    if (existing) return existing;
    const fresh: MarketContextRow = {
      ts,
      symbol,
      fundingRatePct: null,
      openInterestBase: null,
      openInterestUsd: null,
      openInterestChange1hPct: null,
      takerBuySellRatio: null,
      longShortAccountRatio: null,
      premiumPct: null,
    };
    bySymbol.set(symbol, fresh);
    return fresh;
  };

  for (const e of events) {
    if (e.kind === "derivatives" && e.derivatives) {
      const r = row(e.symbol);
      r.fundingRatePct = e.derivatives.fundingRatePct;
      r.openInterestBase = e.derivatives.openInterestBase;
      r.openInterestUsd = e.derivatives.openInterestUsd;
      r.openInterestChange1hPct = e.derivatives.openInterestChange1hPct;
      r.takerBuySellRatio = e.derivatives.takerBuySellRatio;
      r.longShortAccountRatio = e.derivatives.longShortAccountRatio;
    }
    if (e.kind === "premium" && e.premium) {
      row(e.symbol).premiumPct = e.premium.premiumPct;
    }
  }

  return [...bySymbol.values()].filter((r) =>
    [
      r.fundingRatePct,
      r.openInterestBase,
      r.openInterestUsd,
      r.openInterestChange1hPct,
      r.takerBuySellRatio,
      r.longShortAccountRatio,
      r.premiumPct,
    ].some((v) => v !== null),
  );
}

/**
 * Mentés. Ugyanarra az órára és coinra a FRISSEBB érték nyer (upsert), így egy
 * megismételt tick nem hoz létre duplikátumot.
 *
 * SOSEM dob: ezt a tick hívja, és egy naplózási hiba nem ronthatja el a kereskedési
 * ciklust. A visszaadott szám a ténylegesen írt sorok darabszáma.
 */
export async function persistMarketContext(events: DataPoint[], nowMs = Date.now()): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = contextRowsFromEvents(events, nowMs);
  if (rows.length === 0) return 0;
  try {
    await db
      .insert(schema.marketContext)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.marketContext.ts, schema.marketContext.symbol],
        // `excluded` = a BEÉRKEZŐ sor. Több soros insertnél kötelező: egy konkrét sor
        // értékeit beírni minden ütközőre azt jelentené, hogy a BTC adata ráfolyik az ETH-ra.
        set: {
          fundingRatePct: sql`excluded.funding_rate_pct`,
          openInterestBase: sql`excluded.open_interest_base`,
          openInterestUsd: sql`excluded.open_interest_usd`,
          openInterestChange1hPct: sql`excluded.open_interest_change_1h_pct`,
          takerBuySellRatio: sql`excluded.taker_buy_sell_ratio`,
          longShortAccountRatio: sql`excluded.long_short_account_ratio`,
          premiumPct: sql`excluded.premium_pct`,
        },
      });
    return rows.length;
  } catch (e) {
    console.error("[market-context] mentés sikertelen (a ciklus fut tovább):", e);
    return 0;
  }
}

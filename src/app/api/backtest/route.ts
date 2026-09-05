import { NextResponse } from "next/server";
import { loadHistory } from "@/lib/backtest/data";
import { runBacktest } from "@/lib/backtest/engine";
import { COIN_UNIVERSE } from "@/lib/config";

// Hálózati fetch (Binance/F&G) + nehéz számítás — ne fusson build-időben.
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Backtest a valódi motorral: a kód-profit-ciklust futtatja a Binance-historyn,
 * gyertya-fill szimulációval, és metrikákat ad vissza (Sharpe/maxDD/hit-rate).
 * A korábbi naív confidence-súly vázlatot váltja. Lásd backtest spec.
 *
 * Query: ?pages=N (klines-lapok/symbol, default 3) &slippage=BPS (default 5).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pages = Number(url.searchParams.get("pages") ?? 3);
  const slippageBps = Number(url.searchParams.get("slippage") ?? 5);

  try {
    const { frames: history, quality } = await loadHistory([...COIN_UNIVERSE], pages);
    const result = runBacktest(history, {
      symbols: [...COIN_UNIVERSE],
      initialCapitalUsd: 10000,
      feePct: 0.001,
      slippageBps,
    });
    return NextResponse.json({
      ...result.metrics,
      framesCount: history.length,
      from: result.from,
      to: result.to,
      // Az adatminőség a válasz része: réses vagy hiányos sorozat nem tűnhet el csendben.
      dataQuality: quality,
    });
  } catch (e) {
    console.error("[api/backtest]", e);
    return NextResponse.json({ error: "backtest hiba", detail: String(e) }, { status: 500 });
  }
}

import { NextResponse } from "next/server";

/**
 * Admin: trading mode kapcsoló (paper ↔ live).
 *
 * BIZTONSÁG: a live módhoz explicit megerősítés kell ('I-UNDERSTAND-THE-RISK').
 * A tényleges env-frissítés a Vercel dashboard-on történik; ez az endpoint
 * jelzi a szándékot és logolja, valamint visszaadja a jelenlegi módot.
 */
export async function GET() {
  return NextResponse.json({ mode: process.env.TRADING_MODE ?? "paper" });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mode = body.mode;
  const confirm = body.confirm;

  if (mode !== "paper" && mode !== "live") {
    return NextResponse.json({ error: "invalid mode (paper|live)" }, { status: 400 });
  }
  if (mode === "live" && confirm !== "I-UNDERSTAND-THE-RISK") {
    return NextResponse.json(
      { error: "live módhoz explicit megerősítés kell: confirm='I-UNDERSTAND-THE-RISK'" },
      { status: 400 },
    );
  }

  console.warn(`[admin] mode switch kérelem: ${mode} (confirm=${confirm})`);
  return NextResponse.json({
    ok: true,
    mode,
    note: "A tényleges váltás a Vercel TRADING_MODE env-ben történik. Ez az endpoint csak jelzi a szándékot.",
  });
}

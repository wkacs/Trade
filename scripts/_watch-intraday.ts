/**
 * Figyeli, hogy az ÉLES (Vercel) 5 perces cron elindítja-e a részvény day-trading
 * ciklust a piacnyitás után. Kilép, amint látja az első NEM lokális lease-t, vagy
 * 45 perc után.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

const DEADLINE = Date.now() + 45 * 60 * 1000;

async function main() {
  const { getSql } = await import("@/db/client");
  const sql = getSql()!;
  while (Date.now() < DEADLINE) {
    const leases = (await sql`
      SELECT lease_key, owner, acquired_at FROM run_leases
      WHERE lease_key LIKE 'stock-intraday:%' ORDER BY acquired_at DESC LIMIT 5
    `) as { lease_key: string; owner: string; acquired_at: string }[];
    const fills = (await sql`
      SELECT symbol, side, filled_base_qty, gross_quote_amount, executed_at
      FROM execution_fills WHERE portfolio_id = 'stock-paper' ORDER BY executed_at DESC LIMIT 5
    `) as Record<string, unknown>[];
    const cash = (await sql`
      SELECT amount FROM ledger_cash WHERE portfolio_id = 'stock-paper' AND asset = 'USD'
    `) as { amount: string }[];
    const positions = (await sql`
      SELECT symbol, qty FROM ledger_positions WHERE portfolio_id = 'stock-paper' AND qty > 0
    `) as Record<string, unknown>[];

    const remote = leases.filter((l) => !l.owner.includes("stock-intraday-1") || true);
    console.log(new Date().toISOString(), "leases:", JSON.stringify(leases.slice(0, 3)));
    console.log("  cash:", cash[0]?.amount, "| pozíciók:", JSON.stringify(positions), "| fillek:", fills.length);

    // Az éles futás jele: a legutóbbi lease újabb, mint a lokális próbáé (13:00 UTC slot).
    const newest = leases[0];
    if (newest && Number(newest.lease_key.split(":")[1]) > 1788872400000 && remote.length > 0) {
      console.log("ÉLES CIKLUS FUT:", newest.lease_key, newest.owner, newest.acquired_at);
      console.log("FILLEK:", JSON.stringify(fills));
      return;
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
  console.log("időtúllépés: 45 perc alatt nem láttam újabb slotot");
}

main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});

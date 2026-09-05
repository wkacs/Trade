/**
 * A régi (v1) paper ledger átvezetése a v2 mérési epochba — T11.
 *
 * Futtatás:
 *   pnpm tsx scripts/migrate-paper-ledger.ts                       → DRY-RUN (alap)
 *   pnpm tsx scripts/migrate-paper-ledger.ts --apply               → tényleges import
 *   pnpm tsx scripts/migrate-paper-ledger.ts --epoch v2-2026-09-05 → epoch-verzió
 *   pnpm tsx scripts/migrate-paper-ledger.ts --out audit-exports/import.json
 *
 * A DRY-RUN AZ ALAPÉRTELMEZÉS. Az `--apply` nélkül a script SEMMIT nem ír.
 *
 * Amit NEM csinál:
 *  - nem töröl és nem módosít v1 sort (portfolios, positions, trades érintetlen);
 *  - nem ad el semmit, a koncentrált BTC-pozíciót sem;
 *  - nem pótol kitalált tőzsdei azonosítót vagy eredetet;
 *  - nem javítja az irreális régi stop-fill árakat, csak megjelöli őket.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config();

const DEFAULT_EPOCH = "v2-2026-09-05";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const epochVersion = arg("epoch") ?? DEFAULT_EPOCH;
  const outPath = arg("out");

  const {
    readLegacyState,
    planLegacyImport,
    applyLegacyImport,
    buildDiff,
    detectOverweight,
    formatPlanSummary,
    readCurrentLedgerSnapshot,
  } = await import("@/lib/portfolio/legacy-import");

  const legacy = await readLegacyState();
  if (!legacy) {
    console.error("Nincs v1 portfólió az adatbázisban (vagy nincs DATABASE_URL).");
    process.exit(1);
    return;
  }

  const plan = planLegacyImport(legacy, { epochVersion, flagSuspiciousStopFills: true });
  const before = await readCurrentLedgerSnapshot(plan.portfolioId, plan.mode);
  const diff = buildDiff(before, plan);

  console.log(formatPlanSummary(plan));
  console.log("\nEltérésjelentés (v2 ledger előtte → utána):");
  for (const row of diff) {
    console.log(`  ${row.key}: ${row.before} → ${row.after}  (Δ ${row.delta})`);
  }

  // A 20% feletti koncentráció JELENTÉS, nem eladási utasítás.
  const prices: Record<string, string> = {};
  for (const p of plan.openingPositions) {
    const px = process.env[`PRICE_${p.symbol}`];
    if (px) prices[p.symbol] = px;
  }
  if (Object.keys(prices).length > 0) {
    const over = detectOverweight(plan, prices, "0.2");
    if (over.length > 0) {
      console.log("\nTúlsúlyos pozíciók (a migráció NEM adja el őket):");
      for (const o of over) {
        console.log(`  ${o.symbol}: ${o.valueQuote} (${(Number(o.sharePct) * 100).toFixed(1)}%)`);
      }
      console.log("  Ezekre a coinokra a kockázati kapu 0 szabad keretet ad → nincs új vétel.");
    }
  } else if (plan.openingPositions.length > 0) {
    console.log(
      "\nMegjegyzés: árak nélkül a túlsúly nem számolható. Adj meg PRICE_BTC, PRICE_ETH, … env-változókat, ha kell.",
    );
  }

  if (outPath) {
    const { writeFile, mkdir } = await import("fs/promises");
    const { dirname } = await import("path");
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ plan, before, diff }, null, 2), "utf8");
    console.error(`\nKiírva: ${outPath} (pénzügyi adat — NE commitold)`);
  }

  if (!apply) {
    console.log("\nDRY-RUN. Semmi nem íródott. A tényleges importhoz: --apply");
    return;
  }

  const result = await applyLegacyImport(plan, Date.now());
  console.log("\nVégrehajtva:");
  console.log(`  epoch létrehozva: ${result.epochCreated}`);
  console.log(`  nyitóállapot felvéve: ${result.openingSeeded}`);
  console.log(`  történeti sorok beszúrva: ${result.legacyFillsInserted}, már meglévő: ${result.legacyFillsSkipped}`);
  console.log("  A v1 táblák érintetlenek maradtak.");
}

if (process.argv[1] && process.argv[1].includes("migrate-paper-ledger")) {
  main().catch((e) => {
    console.error("[migrate-paper-ledger] hiba:", e);
    process.exit(1);
  });
}

/**
 * A HOLD KONKRÉT indoka — a ténylegesen kiértékelt kapukból, nem az LLM kiesésével.
 *
 * Miért kell: amíg az LLM elhasalt, a döntés-napló minden sora „LLM hiba, HOLD." volt. Ez
 * technikailag igaz, de a naplót olvasó ember számára használhatatlan: nem derül ki belőle,
 * hogy a bot MIÉRT nem vett — pedig ez pontosan tudható, mert a belépő kapuk determinisztikusak.
 *
 * Amit ez a szöveg tartalmaz, az MÉRT tény: a fear-DCA kapuja (valódi F&G érték a valódi
 * küszöbhöz mérve), a momentum-belépő állapota (konfiguráció), és a 24 órás elmozdulások.
 * Amit NEM tartalmaz: kitalált piaci narratíva. Ha egy adat hiányzik, azt kimondja, nem pótolja.
 */
import type { DataPoint } from "@/lib/types";
import type { StrategyConfig } from "@/lib/strategy/config";

/** Előjeles százalék magyar tizedesvesszővel, valódi mínusz-jellel. */
function pct(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${Math.abs(n).toFixed(1).replace(".", ",")}%`;
}

export function holdReason(
  events: DataPoint[],
  strategy: StrategyConfig,
  llmError?: { errorCode?: string; errorMessage?: string },
): string {
  const parts: string[] = [];

  if (llmError) {
    parts.push(`Nincs AI-vélemény (${llmError.errorCode ?? "ismeretlen hiba"}).`);
  }

  // 1) Fear-DCA kapu — a kriptó ág fő belépője. A küszöb a FUTÓ stratégiáé.
  const fg = events.find((e) => e.kind === "sentiment" && e.sentiment)?.sentiment;
  if (fg) {
    const open = fg.value <= strategy.dcaFgThreshold;
    parts.push(
      open
        ? `F&G ${fg.value} (${fg.classification}) ≤ ${strategy.dcaFgThreshold} → a fear-DCA kapuja nyitva.`
        : `F&G ${fg.value} (${fg.classification}) > ${strategy.dcaFgThreshold} → nincs fear-DCA belépő.`,
    );
  } else {
    parts.push("Fear&Greed: nincs F&G adat ebben a ciklusban → a fear-DCA nem értékelhető.");
  }

  // 2) A másik belépő út állapota. Kikapcsolt momentum mellett a fear-DCA az EGYETLEN út.
  parts.push(
    strategy.momentumEnabled
      ? "A momentum-belépő aktív (kitörés a trend fölött)."
      : "A momentum-belépő kikapcsolva — a fear-DCA az egyetlen belépő út.",
  );

  // 3) Mit csinált a piac. Csak amit tényleg megfigyeltünk.
  const moves = events
    .filter((e) => e.kind === "price" && e.price)
    .map((e) => `${e.symbol} ${pct(e.price!.change24hPct)}`);
  if (moves.length > 0) parts.push(`24h: ${moves.join(", ")}.`);

  return parts.join(" ");
}

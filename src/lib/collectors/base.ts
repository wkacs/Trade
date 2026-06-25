import type { DataPoint } from "@/lib/types";

export interface DataCollector {
  name: string;
  collect(): Promise<DataPoint[]>;
}

/**
 * Az összes regisztrált collectort párhuzamosan lefuttatja,
 * és egyesíti az eredményeket. Hibák egy collectorban nem döntik
 * romba a teljes ciklust — a többi eredménye megmarad. Lásd spec §3.1.
 */
export async function collectAll(collectors: DataCollector[]): Promise<DataPoint[]> {
  const results = await Promise.allSettled(collectors.map((c) => c.collect()));
  const ok: DataPoint[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") ok.push(...r.value);
    // rejected: logolunk, de nem dobunk — spec §6 (egy hiba nem omlik össze)
    else console.error("[collectAll] collector hiba:", r.reason);
  }
  return ok;
}

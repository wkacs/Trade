import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

let _db: Db | null = null;
let _sql: NeonQueryFunction<false, false> | null = null;
let _url: string | null = null;

/** A gyorsítótárazott kapcsolat eldobása, ha közben megváltozott a DATABASE_URL. */
function resetIfUrlChanged(url: string | undefined): void {
  if (_url !== (url ?? null)) {
    _db = null;
    _sql = null;
    _url = url ?? null;
  }
}

/**
 * Visszaadja a Neon DB kapcsolatot, vagy null-t ha nincs DATABASE_URL.
 *
 * A modul-import nem dob hiányzó env-re — csak a tényleges query-kor.
 * Így a unit tesztek és a build nem fognak elbukni kulcsok hiányán.
 * A route-ok getDb()-t hívnak, és null-checket tesznek.
 */
export function getDb(): Db | null {
  const url = process.env.DATABASE_URL;
  resetIfUrlChanged(url);
  if (_db) return _db;
  if (!url) return null;
  // fetchOptions no-store: a Neon HTTP-driver fetch-eket a Next.js NE cache-elje
  // (különben a dashboard elavult DB-adatot mutat a force-dynamic ellenére is).
  const sql = neon(url, { fetchOptions: { cache: "no-store" } });
  _sql = sql;
  _db = drizzle(sql, { schema });
  return _db;
}

/**
 * A nyers Neon SQL-tag. Az atomi ledger-műveletek SQL-FÜGGVÉNYT hívnak
 * (apply_fill_v2, acquire_run_lease), mert a HTTP-driver nem ad interaktív
 * tranzakciót — lásd DRIVER_CAPABILITIES és docs/ledger-contract.md.
 */
export function getSql(): NeonQueryFunction<false, false> | null {
  getDb();
  return _sql;
}

/**
 * A TELEPÍTETT driver ténylegesen ellenőrzött képességei (@neondatabase/serverless 0.9.1
 * HTTP mód + drizzle-orm/neon-http 0.33.0). A terv előírja, hogy ezt a megvalósítás
 * elején rögzítsük, ne feltételezzük.
 *
 *  - interactiveTransaction: NINCS. A `neon()` HTTP-tag egyszeri kérésekre való; a
 *    drizzle neon-http drivere `db.transaction()`-re hibát dob ("No transactions support
 *    in neon-http driver"). Nem lehet ugyanabban a tranzakcióban olvasni, dönteni, írni.
 *  - batch: VAN (`db.batch([...])` → egy HTTP kérés, egyetlen szerveroldali tranzakció),
 *    de nem-interaktív: a következő utasítás nem függhet az előző EREDMÉNYÉTŐL.
 *  - sqlFunction: VAN. Egy `SELECT apply_fill_v2(...)` hívás egyetlen tranzakcióban fut
 *    a szerveren, és tud elágazni (pl. duplikált fill esetén nem mozdít egyenleget).
 *
 * EBBŐL KÖVETKEZIK: a több sort érintő, feltételes ledger-írás SQL-függvényen megy.
 */
export const DRIVER_CAPABILITIES = {
  driver: "@neondatabase/serverless (http) + drizzle-orm/neon-http",
  interactiveTransaction: false,
  batch: true,
  sqlFunction: true,
} as const;

export { schema };

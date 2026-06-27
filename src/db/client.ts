import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

let _db: Db | null = null;

/**
 * Visszaadja a Neon DB kapcsolatot, vagy null-t ha nincs DATABASE_URL.
 *
 * A modul-import nem dob hiányzó env-re — csak a tényleges query-kor.
 * Így a unit tesztek és a build nem fognak elbukni kulcsok hiányán.
 * A route-ok getDb()-t hívnak, és null-checket tesznek.
 */
export function getDb(): Db | null {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  // fetchOptions no-store: a Neon HTTP-driver fetch-eket a Next.js NE cache-elje
  // (különben a dashboard elavult DB-adatot mutat a force-dynamic ellenére is).
  const sql = neon(url, { fetchOptions: { cache: "no-store" } });
  _db = drizzle(sql, { schema });
  return _db;
}

export { schema };

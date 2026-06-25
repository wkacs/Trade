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
  const sql = neon(url);
  _db = drizzle(sql, { schema });
  return _db;
}

export { schema };

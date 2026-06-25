import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Neon Postgres kapcsolat (serverless HTTP driver).
 * A DATABASE_URL-t csak futási időben (Vercel env) kell beállítani;
 * a modul-import maga nem dob, ha hiányzik — csak a tényleges query-kor.
 * Így a unit tesztek és a build nem fognak elbukni env hiányán.
 */
function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Éles query-kor ez hibát fog okozni, de nem akad meg a modul betöltése.
    return null as unknown as ReturnType<typeof drizzle>;
  }
  const sql = neon(url);
  return drizzle(sql, { schema });
}

export const db = createDb();
export { schema };

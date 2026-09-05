/**
 * Integrációs teszt setup — CSAK a vitest.integration.config.ts futtatja.
 *
 * Szabály (T01): az integrációs tesztek KIZÁRÓLAG külön, eldobható teszt-adatbázison
 * futhatnak. A setup fail-closed:
 *   - hiányzó TEST_DATABASE_URL      → hiba (nem esünk vissza a normál DB-re)
 *   - TEST_DATABASE_URL === DATABASE_URL → hiba (ugyanaz a DB, éles adat veszélyben)
 *
 * Siker esetén a DATABASE_URL-t a teszt-DB-re ÁLLÍTJUK, hogy a getDb() a teszt-DB-t
 * használja. Az eredeti DATABASE_URL nem kerül vissza a folyamatba.
 */
const testUrl = process.env.TEST_DATABASE_URL?.trim();
const realUrl = process.env.DATABASE_URL?.trim();

if (!testUrl) {
  throw new Error(
    "[integration] Hiányzó TEST_DATABASE_URL. Az integrációs tesztek külön, eldobható " +
      "PostgreSQL adatbázist igényelnek. Példa:\n" +
      '  TEST_DATABASE_URL="postgres://user:pass@localhost:5432/zcode_test" pnpm test:integration',
  );
}
if (realUrl && realUrl === testUrl) {
  throw new Error(
    "[integration] A TEST_DATABASE_URL megegyezik a DATABASE_URL-lel. Az integrációs " +
      "tesztek TÖRLIK/ÍRJÁK a táblákat — külön adatbázis kötelező.",
  );
}

process.env.DATABASE_URL = testUrl;
process.env.TRADING_MODE = "paper";

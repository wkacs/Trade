/**
 * Unit-teszt setup — MINDEN alapértelmezett vitest futásra érvényes (vitest.config.ts).
 *
 * Cél (T01): egyetlen unit-teszt se érhesse el a valódi (éles) adatbázist. A getDb()
 * a DATABASE_URL-ből épít kapcsolatot; ha az env véletlenül be van töltve (pl. .env.local
 * a shellből), egy rosszul mockolt teszt ÍRHATNA az éles paper-ledgerbe.
 *
 * Ezért itt kitöröljük a DB-env-eket. Az integrációs tesztek KÜLÖN configból futnak
 * (vitest.integration.config.ts + tests/integration/setup.ts), saját teszt-DB-vel.
 */
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
// A live-kapcsoló sem szivároghat be: minden unit-teszt paper módban fut.
process.env.TRADING_MODE = "paper";

import { describe, it, expect } from "vitest";

/**
 * Az integrációs setup ellenőrzése: ide csak akkor jutunk el, ha a setup elfogadta a
 * konfigurációt, azaz van külön TEST_DATABASE_URL, és az NEM a normál DATABASE_URL.
 */
describe("integrációs setup", () => {
  it("a DATABASE_URL a teszt-DB-re mutat", () => {
    expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });
});

import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Integrációs tesztek (valódi PostgreSQL). KÜLÖN config és külön parancs:
 *   pnpm test:integration
 *
 * Kötelező env: TEST_DATABASE_URL (eldobható teszt-DB). A setup fail-closed elutasítja
 * a hiányzó vagy az éles DB-vel egyező konfigurációt — lásd tests/integration/setup.ts.
 * Az alapértelmezett `pnpm test` ezeket a fájlokat KIHAGYJA.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(process.cwd(), "src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    // A DB-tesztek sorosan futnak: közös sémán osztoznak.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

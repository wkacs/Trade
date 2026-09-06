import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Alapértelmezett (unit) futás. Az integrációs tesztek (tests/integration/**) KI vannak
 * zárva — azok külön configból, külön teszt-DB-vel futnak (vitest.integration.config.ts).
 * A setup-unit.ts kitörli a DATABASE_URL-t, hogy egyetlen unit-teszt se érhesse el az
 * éles adatbázist.
 */
export default defineConfig({
  // A komponens-szerződés tesztek .tsx forrást importálnak: automatikus JSX-runtime kell,
  // különben az esbuild klasszikus React.createElement hívást fordít, és `React is not defined`.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.join(process.cwd(), "src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "tests/integration/**"],
    setupFiles: ["tests/setup-unit.ts"],
  },
});

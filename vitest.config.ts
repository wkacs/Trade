import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(process.cwd(), "src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
  },
});

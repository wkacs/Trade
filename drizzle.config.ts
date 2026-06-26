import { defineConfig } from "drizzle-kit";
import "dotenv/config";

// Betöltjük a .env.local-t is (Next.js formátum), ha létezik
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { config } = require("dotenv");
  config({ path: ".env.local" });
} catch {
  // .env.local opcionális
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});

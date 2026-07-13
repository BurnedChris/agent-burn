import { defineConfig } from "drizzle-kit";

const databaseUrl =
  process.env.DATABASE_URL_DIRECT?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL_DIRECT (preferred) or DATABASE_URL before running Drizzle Kit.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./agent/lib/db/schema.ts",
  dbCredentials: { url: databaseUrl },
});

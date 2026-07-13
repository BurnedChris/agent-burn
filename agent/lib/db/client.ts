import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

interface DatabaseResources {
  database: NodePgDatabase<typeof schema>;
  pool: Pool;
  url: string;
}

const globalDatabase = globalThis as typeof globalThis & {
  __burnModeDatabase?: DatabaseResources;
};

export function getBurnModeDatabase(): DatabaseResources {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required for Burn Mode Postgres.");
  }

  const existing = globalDatabase.__burnModeDatabase;
  if (existing) {
    if (existing.url !== url) {
      throw new Error("DATABASE_URL changed after the Postgres pool was created.");
    }
    return existing;
  }

  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    max: 5,
  });
  pool.on("error", (error) => {
    const code = String((error as NodeJS.ErrnoException).code ?? "unknown")
      .replace(/[^A-Za-z0-9_-]/gu, "_")
      .slice(0, 32);
    console.error(`Burn Mode Postgres idle client error (${code}).`);
  });
  attachDatabasePool(pool);

  const resources: DatabaseResources = {
    database: drizzle({ client: pool, schema }),
    pool,
    url,
  };
  globalDatabase.__burnModeDatabase = resources;
  return resources;
}

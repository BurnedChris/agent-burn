import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl =
  process.env.DATABASE_URL_DIRECT?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL_DIRECT (preferred) or DATABASE_URL before migrating.",
  );
}

const parsedUrl = new URL(databaseUrl);
if (
  parsedUrl.hostname.endsWith(".psdb.cloud") &&
  parsedUrl.port === "6432"
) {
  throw new Error(
    "PlanetScale schema migrations require a direct port 5432 URL, not PgBouncer port 6432.",
  );
}

// PlanetScale includes libpq/psql-specific TLS options in copied direct URLs.
// node-postgres treats `sslrootcert=system` as a literal local filename, while
// the platform certificate is already verifiable through the system CA store.
if (
  parsedUrl.hostname.endsWith(".psdb.cloud") &&
  parsedUrl.searchParams.get("sslrootcert") === "system"
) {
  parsedUrl.searchParams.delete("sslrootcert");
  parsedUrl.searchParams.delete("sslnegotiation");
}

const pool = new Pool({ connectionString: parsedUrl.toString(), max: 1 });

try {
  await migrate(drizzle({ client: pool }), {
    migrationsFolder: resolve(process.cwd(), "drizzle"),
  });
  console.log("Drizzle migrations applied.");
} finally {
  await pool.end();
}

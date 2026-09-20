import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// postgres-js connects lazily (no socket opens until the first query), so
// constructing the client here is safe even when DATABASE_URL is unset — which
// is what lets CI run the DB-free suite without a live database.
const databaseUrl = process.env.DATABASE_URL ?? "postgres://localhost:5433/hpc_dev";

const client = postgres(databaseUrl);

// `casing` MUST match drizzle.config.ts, or upserts throw duplicate-key errors.
export const db = drizzle(client, { casing: "snake_case" });

export type Database = typeof db;

/** Close the connection pool. Used by integration tests so vitest can exit. */
export async function closeDb(): Promise<void> {
  await client.end();
}

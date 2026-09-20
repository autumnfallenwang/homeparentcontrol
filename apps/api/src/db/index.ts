import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// postgres-js connects lazily (no socket opens until the first query), so
// constructing the client here is safe even when DATABASE_URL is unset — which
// is what lets CI run the DB-free suite without a live database.
const databaseUrl = process.env.DATABASE_URL ?? "postgres://localhost:5433/hpc_dev";

const client = postgres(databaseUrl);

// `casing` MUST match drizzle.config.ts, or upserts throw duplicate-key errors.
//
// `schema` enables the relational query API (`db.query.devices.findFirst({ with: … })`),
// which is what the `relations()` blocks in schema.ts exist for — the policy
// compiler's gather step reads a device, its child, household, windows and
// warnings in one round trip through them.
export const db = drizzle(client, { casing: "snake_case", schema });

export type Database = typeof db;

/** Close the connection pool. Used by integration tests so vitest can exit. */
export async function closeDb(): Promise<void> {
  await client.end();
}

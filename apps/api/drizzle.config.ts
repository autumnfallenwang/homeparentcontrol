import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Emit snake_case columns (Postgres convention + matches the source schema).
  // MUST match the `casing` passed to drizzle() in src/db/index.ts, or upserts
  // throw duplicate-key errors.
  //
  // B1 (docs/design-decisions.md §8.2) gates this: better-auth's drizzle adapter
  // has never been run against snake_case in this house — homework has no auth,
  // homecal is camelCase. Verify before writing migration 0002. camelCase is the
  // documented fallback.
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL! },
});

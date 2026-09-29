import { defineConfig } from "vitest/config";

// Load apps/api/.env for everything EXCEPT the database.
//
// ⚠️ Integration tests TRUNCATE every table. Taking DATABASE_URL from .env
// pointed them at the local dev database, and running a subset without an
// explicit URL wiped it — twice (2026-09-28). So the database must be named
// on the command line, and without one the integration tests self-skip:
//   DATABASE_URL=postgresql://hpc:hpc@localhost:5433/hpc_test pnpm vitest run
const explicitDatabase = process.env.DATABASE_URL;
try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // no .env — fine for DB-free runs
}
if (explicitDatabase === undefined) delete process.env.DATABASE_URL;

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // Integration test files share one Postgres and each truncates tables in
    // beforeEach; running files in parallel makes them clobber each other's
    // rows. Serialize file execution (the house pattern).
    fileParallelism: false,
  },
});

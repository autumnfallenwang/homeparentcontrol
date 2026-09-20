import { defineConfig } from "vitest/config";

// Load apps/api/.env so integration tests get DATABASE_URL without a manual
// --env-file. Guarded: an absent .env is fine — test:fast is DB-free, and
// integration tests self-skip when DATABASE_URL is unset.
try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // no .env — fine for DB-free runs
}

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

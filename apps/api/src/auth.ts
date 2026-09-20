import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "better-auth/plugins";
import { config } from "./config.js";
import { db } from "./db/index.js";
import * as schema from "./db/schema.js";

/**
 * Minimal better-auth wiring.
 *
 * ⚠️ Deliberately incomplete — this exists to close **B1** (does better-auth's
 * drizzle adapter respect `casing: "snake_case"`?) before 29 tables depend on
 * the answer. The admin plugin, the first-user bootstrap hook, the
 * per-household service user (A.21) and the rest of the X2 carve-out are
 * phase 2 step 2.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    // better-auth resolves the apiKey model as `schema.apikeys` (plural) under
    // this flag. Singular `apikey` produces "model not found in the schema
    // object" — homecal's lessons.md records losing time to it.
    usePlural: true,
    schema,
  }),
  trustedOrigins: config.corsOrigins,
  emailAndPassword: { enabled: true },
  advanced: {
    // Postgres generates the UUIDs (`uuid().primaryKey().defaultRandom()`),
    // not better-auth.
    database: { generateId: false },
  },
  plugins: [
    apiKey({
      apiKeyHeaders: "x-api-key",
      defaultPrefix: "hpc_dk_",
      requireName: true,
      // Lets `auth.api.getSession` resolve an x-api-key header into a Session,
      // so one middleware serves both cookie and key callers.
      enableSessionForAPIKeys: true,
      // ⚠️ X2, PLACE 1 OF 4. DO NOT ENABLE.
      //
      // The plugin's default is 10 requests per 24h and it surfaces as 401,
      // NOT 429. Composed with the agent's `401 -> halt_sync_keep_enforcing`,
      // an agent making 1,440 syncs a day would halt permanently about ten
      // minutes after enrolment while reporting itself as "credential
      // revoked" — and keep enforcing a policy it can never update again.
      // homecal hit this in production; it bricked their Kindle display.
      //
      // Carried in from the very first commit so it cannot be forgotten later.
      // The other three places (row level at mint, a boot assertion, and B2's
      // 30-call integration test) land in step 2 with the enrol handler.
      rateLimit: { enabled: false },
    }),
  ],
});

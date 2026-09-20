import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, apiKey, bearer } from "better-auth/plugins";
import { count } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";
import * as schema from "./db/schema.js";
import { claimFirstHousehold } from "./lib/bootstrap.js";
import { log } from "./lib/logger.js";

/**
 * Two callers, one auth system (§5.8):
 *   - the parent, on a better-auth session cookie, under /api/parent/v1/*
 *   - the agent, on `x-api-key: hpc_dk_…`,          under /api/agent/v1/*
 *
 * `enableSessionForAPIKeys` is what lets a single `requireAuth` serve both.
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
  user: {
    additionalFields: {
      // A.21 — marks the one-per-household machine identity that owns every
      // device API key. Declared here so better-auth reads and writes it;
      // `claimFirstHousehold()` sets it via a raw insert.
      isService: { type: "boolean", required: false, defaultValue: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh daily
  },
  advanced: {
    // Postgres generates the UUIDs (`uuid().primaryKey().defaultRandom()`),
    // not better-auth.
    database: { generateId: false },
    // The UI is homeparentcontrol.arch.internal and the API is
    // homeparentcontrol-api.arch.internal — two hosts, so the session cookie
    // needs Domain=.arch.internal to travel to both. Same registrable domain,
    // so this is same-SITE and SameSite=Lax still applies; no TLS needed (X4).
    //
    // ⚠️ Only when COOKIE_DOMAIN is set. In local dev it is unset and cookies
    // stay host-scoped to localhost, because a .arch.internal cookie is
    // invalid there and the browser drops it silently — which looks exactly
    // like "sign-in 200, then 401 on every protected request".
    ...(config.cookieDomain
      ? { crossSubDomainCookies: { enabled: true, domain: config.cookieDomain } }
      : {}),
  },
  plugins: [
    admin(),
    bearer(),
    apiKey({
      apiKeyHeaders: "x-api-key",
      defaultPrefix: "hpc_dk_",
      requireName: true,
      // Lets `auth.api.getSession` resolve an x-api-key header into a Session,
      // so one middleware serves both cookie and key callers.
      enableSessionForAPIKeys: true,
      // Off by default; without it `createApiKey` throws "Metadata is
      // disabled." The mint stamps deviceId and householdId onto the key so a
      // credential can be traced back to the Mac it belongs to without a join
      // through `devices.api_key_id`.
      enableMetadata: true,
      // ⚠️ X2, PLACE 1 OF 4. DO NOT ENABLE.
      //
      // The plugin's default is 10 requests per 24h, and exhaustion throws an
      // APIError that is indistinguishable from a bad credential — it reads as
      // 401 unless `lib/auth-errors.ts` classifies it (measured on 1.4.19;
      // see that file). Composed with the agent's
      // `401 -> halt_sync_keep_enforcing`, an agent making 1,440 syncs a day
      // would halt permanently about ten minutes after enrolment while
      // reporting itself as "credential revoked" — and keep enforcing a policy
      // it can never update again. homecal hit this in production; it bricked
      // their Kindle display.
      //
      // Place 2 is `lib/device-keys.ts` (row level at mint), place 3 is
      // `lib/assert-x2.ts` (boot assertion), place 4 is B2 in
      // `auth.integration.test.ts`.
      rateLimit: { enabled: false },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        // The first human to sign up becomes the better-auth admin. This is
        // all `before` can do — the row does not exist yet, so there is no id
        // to hang a household membership off. See lib/bootstrap.ts.
        before: async (user) => {
          const [result] = await db.select({ value: count() }).from(schema.users);
          if (result?.value === 0) {
            return { data: { ...user, role: "admin" } };
          }
          return { data: user };
        },
        // §5.5's first-run claim. Runs after the user row commits, so it has
        // an id, and is idempotent (no-ops once a household exists).
        //
        // No recursion risk: the service user it creates is a raw drizzle
        // insert, which bypasses the adapter and therefore never re-enters
        // these hooks. Minting it through `auth.api` instead WOULD recurse,
        // and would not enlist in the claim's transaction.
        after: async (user) => {
          try {
            await claimFirstHousehold();
          } catch (err) {
            // Do NOT rethrow: the user row is already committed, so throwing
            // here would report a failed sign-up for an account that exists.
            // `claimFirstHouseholdAtBoot()` repairs this on next start.
            log.error(
              { event: "household.claim_failed", user_id: user.id, err },
              "first-run claim failed — restart the API to repair",
            );
          }
        },
      },
    },
  },
});

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { assertRetentionInvariant, assertSigningConfigured, config } from "./config.js";
import { startJobs } from "./jobs/index.js";
import { assertNoRateLimitedDeviceKeys } from "./lib/assert-x2.js";
import { claimFirstHouseholdAtBoot } from "./lib/bootstrap.js";
import { log } from "./lib/logger.js";

if (!config.databaseUrl) {
  log.error({ event: "config.error" }, "DATABASE_URL is required");
  process.exit(1);
}

// §5.7 — refuse to start rather than silently lose telemetry to the pruner.
try {
  assertRetentionInvariant(config);
} catch (err) {
  log.error({ event: "config.error", err: (err as Error).message }, "retention invariant violated");
  process.exit(1);
}

// A.16 — refuse to serve unauthenticated policy without an explicit opt-in.
try {
  assertSigningConfigured(config);
} catch (err) {
  log.error({ event: "config.error", err: (err as Error).message }, "refusing to start");
  process.exit(1);
}

// ★ X2, PLACE 3 OF 4 — a throttled device key fails in a way the agent reads
// as "credential revoked": it halts syncing and keeps enforcing a stale
// policy, silently and indefinitely. Crashing at boot is the cheaper failure.
try {
  await assertNoRateLimitedDeviceKeys();
} catch (err) {
  log.error({ event: "x2.violation", err: (err as Error).message }, "refusing to start");
  process.exit(1);
}

// §5.5 — repair path only. No-ops on a fresh database and once a household
// exists; claims one if the create hook failed after the user row committed.
try {
  await claimFirstHouseholdAtBoot();
} catch (err) {
  log.error({ event: "household.claim_error", err: (err as Error).message }, "claim check failed");
  process.exit(1);
}

// §5.8's three in-process jobs: liveness 60 s, projection 5 min, nightly.
// ⚠️ Safe only because the chart pins `replicaCount: 1` + `strategy: Recreate`.
startJobs();

const app = createApp();

serve({ fetch: app.fetch, port: config.apiPort }, (info) => {
  log.info({ event: "server.start", port: info.port }, "api server listening");
});

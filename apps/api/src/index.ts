import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { assertRetentionInvariant, assertSigningConfigured, config } from "./config.js";
import { startJobs } from "./jobs/index.js";
import { assertNoRateLimitedDeviceKeys } from "./lib/assert-x2.js";
import { claimFirstHouseholdAtBoot } from "./lib/bootstrap.js";
import { log } from "./lib/logger.js";
import { drainScheduler } from "./lib/scheduler.js";

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

// ★ A crash is one JSON line at `fatal`, not a stack printed across a dozen
// Loki entries. Exit either way: state after an uncaught error is unknown.
process.on("uncaughtException", (err) => {
  log.fatal({ event: "process.crash", kind: "uncaughtException", err }, "process crashed");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.fatal({ event: "process.crash", kind: "unhandledRejection", err }, "process crashed");
  process.exit(1);
});

// §5.8's three in-process jobs: liveness 60 s, projection 5 min, nightly.
// ⚠️ Safe only because the chart pins `replicaCount: 1` + `strategy: Recreate`.
startJobs();

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.apiPort }, (info) => {
  log.info({ event: "server.start", port: info.port }, "api server listening");
});

/**
 * Graceful stop. k8s sends SIGTERM and waits 30 s: stop taking requests, let
 * the scheduler's in-flight run finish, then exit. ⚠️ Only reachable because
 * the container runs `node` directly — under `pnpm start`, pnpm was PID 1 and
 * the signal never arrived here.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ event: "server.shutdown", signal }, "shutting down");
  setTimeout(() => process.exit(0), 20_000).unref();
  server.close();
  await drainScheduler(15_000);
  log.info({ event: "server.stopped" }, "shut down cleanly");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

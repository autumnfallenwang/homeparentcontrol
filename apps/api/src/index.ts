import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { assertRetentionInvariant, config } from "./config.js";
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

const app = createApp();

serve({ fetch: app.fetch, port: config.apiPort }, (info) => {
  log.info({ event: "server.start", port: info.port }, "api server listening");
});

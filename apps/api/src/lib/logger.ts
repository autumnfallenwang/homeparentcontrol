import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name: string; version: string };

// Strip the `@hpc/` scope so Loki sees a flat label (`hpc-api`).
const service = pkg.name.replace(/^@[^/]+\//, "hpc-");

/**
 * Structured logging. Convention:
 *   log.info({ event, req_id, latency_ms, ... }, "message")
 *
 * The agent's logs arrive here as JSON over HTTP and are forwarded to Loki by
 * the control plane — nothing log-shipping runs on the child's Mac.
 */
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service, version: pkg.version },
  timestamp: pino.stdTimeFunctions.isoTime,
});

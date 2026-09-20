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
  /**
   * §5.8 — device tokens (`hpc_dk_…`), enrolment codes and the `x-api-key`
   * header must never reach Loki. Biome's `noSecrets` catches literals in
   * source; it cannot see a runtime log line.
   *
   * ⚠️ Known gap, deliberate: pino redacts by PATH, not by value. It cannot
   * censor a credential interpolated into a message string. These paths cover
   * every shape we actually log; the rest is a discipline — never put a token
   * in the message, always in a field.
   */
  redact: {
    paths: [
      "token",
      "*.token",
      "credential.token",
      "*.credential.token",
      "apiKey",
      "*.apiKey",
      "api_key",
      "*.api_key",
      "code",
      "*.code",
      "req.headers['x-api-key']",
      "*.headers['x-api-key']",
      "headers['x-api-key']",
    ],
    censor: "[redacted]",
  },
});

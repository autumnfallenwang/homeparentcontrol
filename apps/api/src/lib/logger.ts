import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino, { type DestinationStream, type LoggerOptions } from "pino";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name: string; version: string };

// Strip the `@hpc/` scope so Loki sees a flat label (`hpc-api`).
const service = pkg.name.replace(/^@[^/]+\//, "hpc-");

/**
 * What every line inside one request or one job run carries without being
 * told: `{ req_id }` or `{ job, run_id }`. Set by `withLogContext`, read by
 * the `mixin` below — so a handler's own `log.warn(…)` lands next to its
 * request line in Loki, and one run of the projector can be pulled up whole.
 */
const context = new AsyncLocalStorage<Record<string, string>>();

export function withLogContext<T>(fields: Record<string, string>, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn);
}

/**
 * Structured logging — the house contract, identical across the home apps so
 * one Loki query works for all of them:
 *   log.info({ event, req_id, latency_ms, ... }, "static message")
 *
 * ⚠️ The message is STATIC; anything that varies goes in a field. A message
 * with a value in it cannot be counted, grouped or alerted on.
 *
 * The agent's logs stay on the Mac; what it did reaches Postgres via
 * `/events`. Nothing log-shipping runs on the child's Mac.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  base: { service, version: pkg.version },
  timestamp: pino.stdTimeFunctions.isoTime,
  /**
   * ★ `"level":"info"`, not pino's default `"level":30`. Loki recognises the
   * word and sets `detected_level`, which is what Grafana's level colours and
   * filters use; with numbers every line was `detected_level="unknown"` —
   * across all five home apps (checked 2026-09-28). Query with
   * `| json | level="error"`.
   */
  formatters: { level: (label) => ({ level: label }) },
  mixin: () => context.getStore() ?? {},
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
};

/** The same logger writing somewhere else — for tests that read the JSON back. */
export function createLogger(destination?: DestinationStream) {
  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}

export const log = createLogger();

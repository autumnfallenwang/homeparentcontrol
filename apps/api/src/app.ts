import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { requestLogger } from "./middleware/logger.js";

/**
 * Build the Hono app.
 *
 * Middleware order is load-bearing and follows the house pattern:
 *   request log -> cors -> (phase 2: rate limit -> auth) -> routes
 *
 * The rate limiter goes BEFORE auth so unauthenticated traffic is throttled and
 * the limiter can key off the raw `x-api-key` header rather than a resolved
 * session. See docs/design-decisions.md — the X2 carve-out.
 */
export function createApp() {
  const app = new Hono();

  app.use("*", requestLogger);
  app.use("*", cors({ origin: config.corsOrigins, credentials: true }));

  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}

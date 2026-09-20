import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth.js";
import { config } from "./config.js";
import { requestLogger } from "./middleware/logger.js";
import {
  apiRateLimiter,
  enrolGlobalRateLimiter,
  enrolIpRateLimiter,
} from "./middleware/rate-limit.js";
import { signupGate } from "./middleware/signup-gate.js";
import { agentApp } from "./routes/agent.js";
import { enrolApp } from "./routes/enroll.js";
import { parentApp } from "./routes/parent.js";

/**
 * Build the Hono app.
 *
 * Middleware order is load-bearing:
 *   request log -> cors -> rate limit -> signup gate -> auth handler -> routes
 *
 * The rate limiter goes BEFORE auth so unauthenticated traffic is throttled
 * and the limiter can key off the raw `x-api-key` header rather than a
 * resolved session. Per-route auth (`requireAuth`) lives on the two sub-apps.
 *
 * ⚠️ There is deliberately NO global `onError`. The parent routes hand-map
 * their errors to the house's flat `{ error }`, and a global handler would
 * swallow them. The agent sub-app gets its own scoped `problem+json` handler
 * in step 4 (§5.8).
 *
 * Single mount only — no `/api` + `/api/v1` pair and no Sunset header
 * middleware. That machinery exists in homecal to carry a legacy client
 * through a deprecation; a greenfield app inherits the debt for nothing.
 */
export function createApp() {
  const app = new Hono();

  app.use("*", requestLogger);
  app.use("*", cors({ origin: config.corsOrigins, credentials: true }));

  // Skipped under NODE_ENV=test so the in-memory store cannot bleed between
  // tests. B2 depends on this: it needs to isolate better-auth's per-key
  // limiter from this one, which is a different mechanism with a different
  // (honest) failure mode.
  if (process.env.NODE_ENV !== "test") {
    app.use("/api/*", apiRateLimiter);
  }

  // §5.5 — public sign-up closes after the first user claims the household.
  // Must precede the auth handler; it gates one of its routes.
  app.use("/api/auth/*", signupGate);
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.route("/api/parent/v1", parentApp);

  // ⚠️ BEFORE agentApp, and on its own instance. `/enroll` is the only
  // unauthenticated write endpoint; `agentApp` applies requireAuth to
  // everything on it, so enrolment cannot live there.
  //
  // Its own hard limiters: 5/min/IP and 20/hour globally, because it is the
  // only route reachable without a credential. ⚖️ Never tighten these to the
  // point where a parent fat-fingering a code three times locks themselves out
  // of adding their own Mac.
  if (process.env.NODE_ENV !== "test") {
    app.use("/api/agent/v1/enroll", enrolIpRateLimiter);
    app.use("/api/agent/v1/enroll", enrolGlobalRateLimiter);
  }
  app.route("/api/agent/v1/enroll", enrolApp);

  app.route("/api/agent/v1", agentApp);

  return app;
}

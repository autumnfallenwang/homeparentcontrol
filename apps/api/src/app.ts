import { CONTRACT_MINOR } from "@hpc/contract";
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
 * The parent routes hand-map their errors to the house's flat `{ error }`;
 * the global `onError` below only answers a throw nothing handled, and the
 * agent sub-apps keep their own scoped `problem+json` handler (§5.8,
 * amended by ADR 0012).
 *
 * Single mount only — no `/api` + `/api/v1` pair and no Sunset header
 * middleware. That machinery exists in homecal to carry a legacy client
 * through a deprecation; a greenfield app inherits the debt for nothing.
 */
export function createApp() {
  const app = new Hono();

  app.use("*", requestLogger);

  /**
   * ★ The last resort for a THROWN error nothing else handled: the house's
   * flat `{ error }` and a 500. It does not log — the request line above
   * already carries `err` at `error` level, as one JSON line. Without it,
   * Hono's default printed a multi-line stack Loki split into one entry per
   * line (ADR 0012).
   *
   * It swallows nothing: hand-mapped errors are RETURNED responses and never
   * reach it, and the agent sub-apps keep their own `problem+json` handler,
   * which Hono applies to their routes first.
   */
  app.onError((_err, c) => c.json({ error: "internal" }, 500));
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

  // The k8s probe. Distinct from the agent's, below.
  app.get("/health", (c) => c.json({ status: "ok" }));

  /**
   * `GET /api/agent/v1/health` — §4.5's unauthenticated liveness of the
   * SERVER, which the agent uses to tell "the control plane is down" from "my
   * credential is bad".
   *
   * ⚠️ Deliberately reads no database. It reports whether this process is
   * serving, not whether any device is healthy — A.26 keeps the latter on the
   * tick. Having no failure path is also why it needs no agent `onError`, and
   * so lives here rather than on a third Hono instance.
   *
   * `contract_versions` is plural in the contract: the minors this server
   * speaks (R3 — major in the path, minor in a field).
   */
  app.get("/api/agent/v1/health", (c) => {
    // ⚠️ `no-store`: this carries `server_time`, and a cached copy is a stale
    // clock. Observed 2026-10-03: after every backwards clock step, macOS's
    // URLSession served the previous reply from its cache (ADR 0015).
    c.header("Cache-Control", "no-store");
    return c.json({
      status: "ok",
      contract_versions: [CONTRACT_MINOR],
      server_time: new Date().toISOString(),
    });
  });

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

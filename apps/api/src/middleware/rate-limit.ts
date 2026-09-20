import type { Context } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { config } from "../config.js";

/**
 * Build a stable per-caller rate-limit key with the following precedence:
 *   1. `x-api-key` header value — uniquely identifies one enrolled device
 *   2. session user id (only set when some upstream middleware already ran
 *      auth; for the parent web flow we fall through to IP)
 *   3. forwarded IP from `x-forwarded-for` / `x-real-ip` / `anon`
 *
 * Keying on the raw header rather than a resolved session is why the limiter
 * mounts BEFORE auth: unauthenticated traffic gets throttled too.
 *
 * Exported separately for unit testing.
 */
export function getRateLimitKey(c: Context): string {
  const apiKey = c.req.header("x-api-key");
  if (apiKey) return `key:${apiKey}`;
  const user = c.get("user") as { id?: string } | undefined;
  if (user?.id) return `user:${user.id}`;
  return `ip:${clientIp(c)}`;
}

/** Best-effort client IP. Behind Traefik the real address is in x-forwarded-for. */
export function clientIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "anon";
}

const baseLimiterOptions = {
  windowMs: 60_000,
  standardHeaders: "draft-7" as const,
};

/**
 * Default limiter for everything under `/api/*`.
 *
 * ⚠️ Correctly calibrated as-is — do NOT tighten it to "save" anything. The
 * agent's steady state is 1 request/min and its worst case (`attended` mode,
 * 5 s cadence) is 12/min. 600/min leaves two orders of magnitude of headroom,
 * and it reports itself honestly: a real 429 with draft-7 RateLimit-* headers,
 * not the 401 that better-auth's per-key limiter would have returned (X2).
 */
export const apiRateLimiter = rateLimiter({
  ...baseLimiterOptions,
  limit: config.rateLimitPerMin,
  keyGenerator: getRateLimitKey,
  message: { error: "Too many requests" },
});

/**
 * ⚠️ NOT MOUNTED YET — `POST /api/agent/v1/enroll` is phase 2 step 4. Defined
 * here so the two limiters live beside the one they must not be confused with.
 *
 * Enrolment is the only unauthenticated write endpoint, so it is keyed on IP
 * rather than on a credential it does not have yet. Defence in depth with the
 * per-enrolment `attempts` counter, which burns the row after 5 failures.
 *
 * ⚖️ It must NEVER be tightened to the point where a parent fat-fingering a
 * code three times locks themselves out of adding their own Mac. A bad code is
 * a 404/400, never a 401, so it can never be confused with a revoked
 * credential.
 */
export const enrolIpRateLimiter = rateLimiter({
  ...baseLimiterOptions,
  limit: 5,
  keyGenerator: (c) => `enrol-ip:${clientIp(c)}`,
  message: { error: "Too many enrolment attempts" },
});

/**
 * The global half: 20/hour across all IPs.
 *
 * ⚠️ In-process memory, so this counts per replica. Safe only because the
 * chart pins `replicaCount: 1` + `strategy: Recreate` (§5.8). If replicas ever
 * exceed 1 this needs a shared store, the same way the liveness scheduler
 * would need `pg_try_advisory_lock`.
 */
export const enrolGlobalRateLimiter = rateLimiter({
  windowMs: 3_600_000,
  standardHeaders: "draft-7" as const,
  limit: 20,
  keyGenerator: () => "enrol-global",
  message: { error: "Too many enrolment attempts" },
});

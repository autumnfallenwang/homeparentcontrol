import { createMiddleware } from "hono/factory";
import { auth } from "../auth.js";
import { isRateLimitError } from "../lib/auth-errors.js";
import { ProblemError } from "../lib/problem.js";

type Session = typeof auth.$Infer.Session;

/** Context set by `requireAuth`. Sub-apps mounting it should declare this. */
export type AuthVariables = {
  user: Session["user"];
  session: Session["session"];
};

/**
 * One middleware for both callers. `enableSessionForAPIKeys` makes the apiKey
 * plugin synthesise a Session from an `x-api-key` header, so a parent's cookie
 * and an agent's device key both resolve through `getSession`.
 *
 * (homecal imports `auth` dynamically here to dodge an import cycle. There is
 * no cycle in this tree and `db` is a lazy postgres-js client, so a static
 * import is fine and keeps the types direct.)
 */
/**
 * Resolve a session from request headers, classifying the two failure modes.
 *
 * Shared by both callers because the classification — particularly telling a
 * throttle apart from a bad credential (X2) — must not be duplicated. The
 * *shape* of the response differs per sub-app: parent routes get the house's
 * flat `{ error }`, agent routes get RFC 9457 `problem+json` + `hpc_action`.
 */
export async function resolveSession(
  headers: Headers,
): Promise<
  | { ok: true; session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>> }
  | { ok: false; reason: "unauthorized" | "rate_limited" }
> {
  try {
    const session = await auth.api.getSession({ headers });
    if (!session) return { ok: false, reason: "unauthorized" };
    return { ok: true, session };
  } catch (err) {
    // A quota error is not an auth failure — an exhausted key must stay
    // distinguishable from an invalid one. See X2.
    return { ok: false, reason: isRateLimitError(err) ? "rate_limited" : "unauthorized" };
  }
}

export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  // Better Auth throws `APIError` from inside `getSession` when the request
  // carries an invalid, expired or disabled key. Treat that as an auth
  // failure rather than letting it bubble up as a 500.
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch (err) {
    // A quota error is not an auth failure — surface it as 429 so an
    // exhausted key is distinguishable from an invalid one. See X2.
    if (isRateLimitError(err)) {
      return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429);
    }
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", session.user);
  c.set("session", session.session);
  return next();
});

/**
 * The agent sub-app's auth.
 *
 * Identical logic to `requireAuth`, different failure shape: it throws so the
 * agent-scoped `onError` can emit `problem+json` with an `hpc_action`. That
 * matters most for 401 — X1b makes `halt_sync_keep_enforcing` the single most
 * important mapping on the wire, and a flat `{ error }` carries no action at
 * all, leaving a revoked device with no defined behaviour.
 */
export const requireAgentAuth = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const result = await resolveSession(c.req.raw.headers);
  if (!result.ok) {
    throw new ProblemError(result.reason === "rate_limited" ? "rateLimited" : "unauthorized");
  }
  c.set("user", result.session.user);
  c.set("session", result.session.session);
  return next();
});

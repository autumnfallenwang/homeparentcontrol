import { createMiddleware } from "hono/factory";
import { auth } from "../auth.js";
import { isRateLimitError } from "../lib/auth-errors.js";

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

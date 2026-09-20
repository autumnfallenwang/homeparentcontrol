import { Hono } from "hono";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";

/**
 * The agent's half of the API, mounted at `/api/agent/v1`.
 *
 * A separate Hono instance is FORCED, not stylistic: §5.8 requires an
 * `onError` scoped to the agent routes (emitting RFC 9457 `problem+json` plus
 * `hpc_action`) and explicitly forbids a global one. Hono's `onError` is
 * per-instance and cannot be scoped to a path prefix, so the only way to have
 * one is a second instance. That handler arrives with the real endpoints in
 * step 4; the instance exists now so it has somewhere to go.
 *
 * `POST /enroll` will mount OUTSIDE this `requireAuth` — it is the one
 * unauthenticated write endpoint, guarded by the enrolment code and the IP
 * limiters in middleware/rate-limit.ts.
 */
export const agentApp = new Hono<{ Variables: AuthVariables }>();

agentApp.use("*", requireAuth);

/**
 * Credential introspection. Answers "is this key valid, and who is it?" —
 * the first thing worth knowing when an agent starts returning 401s.
 *
 * Also the route B2 hammers: the gate asserts 30 consecutive authenticated
 * calls all return 200, proving better-auth's per-key limiter is really off
 * (X2 place 4). `/sync` is step 4's; what B2 asserts is about the credential
 * path, not about what the route returns.
 */
agentApp.get("/whoami", (c) => {
  const user = c.get("user");
  return c.json({ user_id: user.id, is_service: user.isService === true });
});

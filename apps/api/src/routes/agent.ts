import { and, desc, eq, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { db } from "../db/index.js";
import { devices, policyVersions } from "../db/schema.js";
import { agentOnError, ProblemError } from "../lib/problem.js";
import { type AuthVariables, requireAgentAuth } from "../middleware/auth.js";

/**
 * The agent's half of the API, mounted at `/api/agent/v1`.
 *
 * A separate Hono instance is FORCED, not stylistic: §5.8 requires an
 * `onError` scoped to the agent routes (emitting RFC 9457 `problem+json` plus
 * `hpc_action`) and explicitly forbids a global one. Hono's `onError` is
 * per-instance and cannot be scoped to a path prefix, so the only way to have
 * one is a second instance.
 *
 * `POST /enroll` mounts OUTSIDE this instance entirely — see routes/enroll.ts.
 */
type AgentVariables = AuthVariables & { deviceId: string };

export const agentApp = new Hono<{ Variables: AgentVariables }>();

agentApp.onError(agentOnError);
agentApp.use("*", requireAgentAuth);

/**
 * Resolve which device is calling, from the credential it presented.
 *
 * §5.9: "the device key can call `/sync`, `/policy` (read) and `/events` for
 * *its own* `device_id` and nothing else" — so every agent handler needs this,
 * and scope is the actual security control here, not the transport (X4).
 *
 * ⚠️ MEASURED, not documented: better-auth 1.4.19 synthesises the API-key
 * session using the **key's own id as the session id**, so `session.id` is the
 * `apikeys.id` that `devices.api_key_id` points at. Verified directly against
 * `verifyApiKey().key.id`. If a future version changes that, this lookup finds
 * no row and the caller gets 403 — fail-closed, and enforcement continues per
 * X1b. `policy.integration.test.ts` pins the equivalence so the break shows up
 * in CI rather than in production.
 */
export const requireDevice = createMiddleware<{ Variables: AgentVariables }>(async (c, next) => {
  const session = c.get("session") as { id?: string } | undefined;
  if (!session?.id) throw new ProblemError("unauthorized");

  const [device] = await db
    .select({ id: devices.id, status: devices.status })
    .from(devices)
    .where(eq(devices.apiKeyId, session.id));

  if (!device) throw new ProblemError("scopeViolation", "this credential is not bound to a device");
  if (device.status === "decommissioned") {
    // ⚠️ The ONE place `decommission` is legitimate: authenticated, and set by
    // a parent. Never inferred from a status code.
    throw new ProblemError("deviceRevoked", "this device was decommissioned", {
      action: "decommission",
    });
  }

  c.set("deviceId", device.id);
  return next();
});

/**
 * Credential introspection. Answers "is this key valid, and who is it?" — the
 * first thing worth knowing when an agent starts returning 401s.
 */
agentApp.get("/whoami", requireDevice, (c) => {
  const user = c.get("user");
  return c.json({
    user_id: user.id,
    is_service: user.isService === true,
    device_id: c.get("deviceId"),
  });
});

/**
 * `GET /api/agent/v1/policy` — the canonical policy resource (§4.5).
 *
 * Proper RFC 9110 conditional GET: an `If-None-Match` matching the current
 * ETag returns `304`. The agent uses it on cold start or after a sync response
 * fails schema validation; operators use it with `curl` constantly.
 *
 * ⚠️ THIS HANDLER MUST NOT TOUCH `devices.last_sync_at`, `health_state` or
 * anything else the liveness job reads. A.26 makes the tick the heartbeat, and
 * §4.5 says operators poll this endpoint constantly — so if a read here
 * counted as liveness, an operator curling a dead device's policy would keep
 * it looking HEALTHY, which is precisely the failure the health design exists
 * to prevent. The spec never says this; the integration test asserts it.
 */
agentApp.get("/policy", requireDevice, async (c) => {
  const deviceId = c.get("deviceId");

  const [current] = await db
    .select({
      etag: policyVersions.etag,
      version: policyVersions.version,
      document: policyVersions.document,
      jws: policyVersions.jws,
    })
    .from(policyVersions)
    .where(and(eq(policyVersions.deviceId, deviceId), lte(policyVersions.notBefore, sql`now()`)))
    .orderBy(desc(policyVersions.version))
    .limit(1);

  // §5.5 compiles v1 inside the enrolment transaction precisely so a cold
  // start cannot land here. Defensive, and deliberately actionless — 404 is
  // absent from §4.7's table and no agent behaviour is defined for it.
  if (!current) throw new ProblemError("policyNotFound");

  c.header("ETag", current.etag);
  c.header("Cache-Control", "no-cache");

  if (c.req.header("if-none-match") === current.etag) {
    return c.body(null, 304);
  }

  // The same envelope `/sync` uses, so one decoder serves both. `jws` when
  // signed; the bare document only when running unsigned, which takes an
  // explicit opt-in at boot.
  const base = { unchanged: false as const, etag: current.etag, policy_version: current.version };
  return c.json(
    current.jws ? { ...base, jws: current.jws } : { ...base, document: current.document },
  );
});

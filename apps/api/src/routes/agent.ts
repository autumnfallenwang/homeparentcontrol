import { and, desc, eq, gt, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { db } from "../db/index.js";
import { apikeys, devices, policyVersions } from "../db/schema.js";
import type { DevicePermission } from "../lib/device-keys.js";
import { agentOnError, ProblemError } from "../lib/problem.js";
import { type AuthVariables, requireAgentAuth } from "../middleware/auth.js";
import { handleCredentialRotate } from "./credential.js";
import { handleEvents } from "./events.js";
import { handleSync } from "./sync.js";

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
type AgentVariables = AuthVariables & { deviceId: string; householdId: string };

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
/**
 * Does this key carry the scope the route needs?
 *
 * better-auth stores `permissions` as a JSON string on the row. Read here
 * rather than via `verifyApiKey` so the check costs no extra round trip — the
 * device lookup already has to happen.
 *
 * ⚠️ Absent permissions means a key minted before scoping existed. Treated as
 * unscoped-and-allowed so an in-flight device is not locked out by a deploy;
 * remove this branch once no such key can exist.
 */
function hasPermission(raw: string | null, needed: DevicePermission): boolean {
  if (!raw) return true;
  try {
    const parsed = JSON.parse(raw) as { device?: string[] };
    return parsed.device?.includes(needed) ?? false;
  } catch {
    return false;
  }
}

function deviceResolver(opts: { allowDecommissioned: boolean; permission?: DevicePermission }) {
  return createMiddleware<{ Variables: AgentVariables }>(async (c, next) => {
    const session = c.get("session") as { id?: string } | undefined;
    if (!session?.id) throw new ProblemError("unauthorized");

    const [device] = await db
      .select({
        id: devices.id,
        householdId: devices.householdId,
        status: devices.status,
        permissions: apikeys.permissions,
      })
      .from(devices)
      .innerJoin(apikeys, eq(apikeys.id, session.id))
      // ★ The CURRENT key, or the superseded one inside its 24 h overlap.
      //
      // ⚠️ Matching only `api_key_id` makes the overlap worthless. The old
      // key still AUTHENTICATES — better-auth's row is enabled and unexpired
      // — but `devices.api_key_id` already points at the new one, so the
      // lookup finds nothing and the device gets a 403. 403 maps to
      // `halt_sync_keep_enforcing`, which is precisely the stranding the
      // overlap was built to prevent: a Mac that rotated, lost power before
      // persisting the new token, and can now never sync again without
      // someone standing in front of it with a one-time code.
      //
      // Found by `credential.integration.test.ts`'s "the OLD credential still
      // works immediately after rotation", which failed with 403.
      //
      // The window is bounded by `previous_api_key_expires_at`, and
      // independently by better-auth's own `expiresAt` on the row — so a
      // stale pointer here cannot extend a credential's life on its own.
      .where(
        or(
          eq(devices.apiKeyId, session.id),
          and(
            eq(devices.previousApiKeyId, session.id),
            gt(devices.previousApiKeyExpiresAt, sql`now()`),
          ),
        ),
      );

    if (!device) {
      throw new ProblemError("scopeViolation", "this credential is not bound to a device");
    }
    if (opts.permission && !hasPermission(device.permissions, opts.permission)) {
      throw new ProblemError("scopeViolation", `this credential lacks ${opts.permission}`);
    }
    if (device.status === "decommissioned" && !opts.allowDecommissioned) {
      // ⚠️ The ONE place `decommission` is legitimate: authenticated, and set
      // by a parent. Never inferred from a status code.
      throw new ProblemError("deviceRevoked", "this device was decommissioned", {
        action: "decommission",
      });
    }

    c.set("deviceId", device.id);
    c.set("householdId", device.householdId);
    return next();
  });
}

/** Nothing should hand a decommissioned device new policy or new work. */
export const requireDevice = deviceResolver({ allowDecommissioned: false });

/** Per-endpoint scopes (§5.9). Each route asks for exactly what it needs. */
export const requireSyncScope = deviceResolver({
  allowDecommissioned: false,
  permission: "sync",
});
export const requirePolicyScope = deviceResolver({
  allowDecommissioned: false,
  permission: "policy:read",
});

/**
 * ⚠️ `/events` alone accepts a decommissioned device.
 *
 * Decommissioning asks the agent to emit a final `agent.decommissioned` audit
 * event — which the strict resolver would refuse, since the device is already
 * decommissioned by then. §5.5 is explicit that decommissioning retains **all
 * telemetry**: "the child's history is not the device's property". Telemetry
 * is write-only, so accepting it costs nothing and preserves the one record
 * that documents the decommission.
 */
export const requireDeviceForTelemetry = deviceResolver({
  allowDecommissioned: true,
  permission: "events:write",
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
agentApp.get("/policy", requirePolicyScope, async (c) => {
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

/**
 * `POST /api/agent/v1/sync` — the tick, and the heartbeat (A.26). The handler
 * lives in `sync.ts`; this file stays a routing table.
 */
agentApp.post("/sync", requireSyncScope, handleSync);

/**
 * `POST /api/agent/v1/events` — telemetry (§4.4).
 *
 * ⚠️ A.27 keeps this OFF the tick: "a 413 / 429 / poisoned batch must never
 * make a live agent look silent." The converse follows and the spec never
 * states it — this endpoint must not write `last_sync_at` either, or a device
 * whose sync daemon is dead but whose queue is still draining would look
 * healthy. The handler asserts nothing about liveness; the test asserts that.
 */
agentApp.post("/events", requireDeviceForTelemetry, handleEvents);

/**
 * `POST /api/agent/v1/credential/rotate` — a device swaps its credential, old
 * one valid for another 24 h. Handler in `credential.ts`.
 *
 * ⚠️ Guarded by `requireSyncScope`, not a scope of its own. A new permission
 * string would not be present on any key minted before it existed, and
 * `hasPermission` treats absent permissions as allowed — so a fresh scope
 * would be enforced on new devices and silently skipped on old ones, which is
 * the worst of both. `sync` is the right authority: rotation is part of
 * staying in touch with the control plane, and nothing else can reach it.
 */
agentApp.post("/credential/rotate", requireSyncScope, handleCredentialRotate);

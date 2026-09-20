import { z } from "zod";
import { policyDocument } from "./policy.js";
import { instant, timezone, uuid } from "./primitives.js";
import { CONTRACT_MINOR } from "./version.js";

/**
 * `POST /api/agent/v1/sync` — the tick, and the heartbeat (§4.2).
 *
 * ⚠️ `policy_state`, `enforcement`, `clock` and `queue` are heartbeat content,
 * NOT telemetry. `DEGRADED` is computed from them, so they must never migrate
 * to `/events` — doing so would make health uncomputable exactly when
 * telemetry is backed up.
 *
 * Several sub-fields below appear in the spec with a single example value and
 * no enumeration (`previous_stop_reason`, `enforcement.state`,
 * `last_eval_result`, `next_boundary_kind`, `last_action.*`,
 * `policy_state.source`). They are typed as open strings rather than invented
 * enums — R2 forbids renaming later, so guessing is expensive.
 */

export const syncDevice = z.object({
  device_id: uuid,
  boot_id: uuid,
  hardware_uuid: z.string(),
  agent_version: z.string(),
  os_version: z.string(),
  arch: z.string(),
  system_boot_time: instant,
});

export const syncAgent = z.object({
  started_at: instant,
  uptime_s: z.int().nonnegative(),
  tick_seq: z.int().nonnegative(),
  clean_exit_previous_run: z.boolean(),
  previous_stop_reason: z.string().nullable().optional(),
  /** Non-null shape is never specified in the document. Opaque until it is. */
  kill_switch: z.unknown().nullable().optional(),
  enforcer_health_age_s: z.int().nonnegative(),
  /** R4 — open, negotiated list. Never close this into an enum. */
  capabilities: z.array(z.string()).default([]),
});

export const syncClock = z.object({
  local_utc: instant,
  system_timezone: timezone,
  policy_timezone: timezone,
  tzdata_version: z.string().optional(),
  using_network_time: z.boolean(),
  continuous_ns: z.number(),
  skew_estimate_ms: z.number(),
  stepped_since_last_sync: z.boolean(),
});

export const syncPolicyState = z.object({
  etag: z.string().nullable().optional(),
  policy_version: z.int().nullable().optional(),
  applied_at: instant.nullable().optional(),
  age_s: z.int().nonnegative().nullable().optional(),
  source: z.string().optional(),
  signature_valid: z.boolean().optional(),
  using_lkg: z.boolean().optional(),
});

export const syncEnforcement = z.object({
  state: z.string(),
  last_eval_at: instant.nullable().optional(),
  last_eval_result: z.string().nullable().optional(),
  active_window_id: uuid.nullable().optional(),
  next_boundary_at: instant.nullable().optional(),
  next_boundary_kind: z.string().nullable().optional(),
  last_action: z
    .object({ type: z.string(), at: instant, result: z.string() })
    .nullable()
    .optional(),
  actions_last_24h: z.int().nonnegative().optional(),
  consecutive_eval_failures: z.int().nonnegative().optional(),
});

export const syncOverrideState = z.object({
  active_grants: z.array(z.object({ id: uuid, minutes: z.int(), expires_at: instant })).default([]),
  minutes_granted_today: z.int().nonnegative().optional(),
  grants_today: z.int().nonnegative().optional(),
});

export const syncQueue = z.object({
  depth: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  oldest_event_at: instant.nullable().optional(),
  evicted_since_last_sync: z.int().nonnegative().optional(),
});

/** R6 — `unsupported` is terminal. */
export const convergedReport = z.object({
  desired_id: uuid,
  status: z.string(),
  observed_at: instant.nullable().optional(),
  detail: z.string().nullable().optional(),
});

export const syncRequest = z.object({
  contract: z.int().default(CONTRACT_MINOR),
  device: syncDevice,
  agent: syncAgent,
  clock: syncClock,
  policy_state: syncPolicyState,
  enforcement: syncEnforcement,
  override: syncOverrideState.optional(),
  queue: syncQueue,
  converged: z.array(convergedReport).default([]),
});
export type SyncRequest = z.infer<typeof syncRequest>;

/**
 * Desired state (§4.5). Four kinds, no escape hatch, idempotent by
 * `desired_id`, re-sent every tick until the SERVER observes convergence.
 *
 * ⚠️ Only `agent_version`'s spec is documented (`{version, pkg_url, sha256}`).
 * `credential`, `diagnostics` and `self_test` are unspecified, so `spec` is
 * opaque — consistent with R8's store-first spirit, and it keeps R2 safe.
 */
export const DESIRED_KINDS = ["credential", "diagnostics", "self_test", "agent_version"] as const;

export const desiredItem = z.object({
  desired_id: uuid,
  /** Open on purpose: an unknown kind must be reportable as `unsupported`, not rejected (R6). */
  kind: z.string(),
  spec: z.unknown().optional(),
});

/** The three-variant policy envelope. Only the `unchanged` form is given as JSON in the spec. */
export const syncPolicyEnvelope = z.union([
  z.object({
    unchanged: z.literal(true),
    etag: z.string().optional(),
    policy_version: z.int().optional(),
  }),
  z.object({
    unchanged: z.literal(false),
    etag: z.string().optional(),
    policy_version: z.int().optional(),
    /** Compact JWS, `alg: EdDSA` (Ed25519). Verify the bytes, THEN parse. */
    jws: z.string(),
  }),
  z.object({
    unchanged: z.literal(false),
    etag: z.string().optional(),
    policy_version: z.int().optional(),
    /** Sent only when signing is disabled; the agent logs `policy_unsigned`. */
    document: policyDocument,
  }),
]);

export const syncResponse = z.object({
  contract: z.int().default(CONTRACT_MINOR),
  server_time: instant,
  /** Vocabulary is ambiguous in the spec (row lifecycle vs health vs administrative). Open string. */
  device_status: z.string(),
  policy: syncPolicyEnvelope.optional(),
  desired: z.array(desiredItem).default([]),
  /** Agent clamps to [1000, 300000]; the spec does not say the server enforces it. */
  next_poll_after_ms: z.int().positive(),
  server_capabilities: z.array(z.string()).default([]),
});
export type SyncResponse = z.infer<typeof syncResponse>;

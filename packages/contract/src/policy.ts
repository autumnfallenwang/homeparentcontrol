import { z } from "zod";
import {
  calendarDate,
  degradingEnum,
  instant,
  timeOfDay,
  timezone,
  uuid,
  weekday,
} from "./primitives.js";

/**
 * The policy document — the JWS payload (§4.3).
 *
 * R7: full state, never a diff. There is no patch or partial-apply variant.
 *
 * ⚠️ The agent verifies the JWS signature over the raw bytes and only THEN
 * parses with this schema, so there is no JSON-canonicalisation question.
 * This schema is a payload decoder, not something reached through the sync
 * response.
 */

/** R5 — an unrecognised action degrades to the safe default rather than crashing. */
export const { strict: enforcementActionStrict, tolerant: enforcementAction } = degradingEnum(
  ["warn_only", "lock", "shutdown"],
  "lock",
);

export const { strict: warningChannelStrict, tolerant: warningChannel } = degradingEnum(
  ["banner", "modal"],
  "modal",
);

export const warning = z.object({
  /** 1–240. Unique per (window, lead_minutes). */
  lead_minutes: z.int().min(1).max(240),
  channel: warningChannel.default("modal"),
});

export const actionOptions = z.object({
  /**
   * ⚠️ Minimum 60, not 0 — X12. A grace of zero silently reconstitutes bare
   * shutdown and deletes all four arguments that produced the lock→grace→
   * shutdown ladder, without anyone editing the action. §4.3 and the DB CHECK
   * still say [0, 3600]; X12 supersedes them.
   */
  shutdown_grace_s: z.int().min(60).max(3600).default(300),
  escalate_after_failures: z.int().min(1).default(3),
});

export const scheduleWindow = z.object({
  id: uuid,
  label: z.string(),
  days: z.array(weekday).min(1),
  restricted_from: timeOfDay,
  restricted_until: timeOfDay,
  action: enforcementAction.default("lock"),
  action_options: actionOptions.optional(),
  warnings: z.array(warning).default([]),
});

export const schedule = z.object({
  /** D.4's discriminator. `windows` is the only value today; budgets ship empty. */
  kind: z.literal("windows"),
  windows: z.array(scheduleWindow).default([]),
});

export const { strict: overrideTypeStrict, tolerant: overrideType } = degradingEnum(
  ["extend", "suspend", "grant_minutes"],
  "extend",
);

/** `offline_code` is deliberately NOT a value here — D.5 deferred the offline path. */
export const { strict: grantedViaStrict, tolerant: grantedVia } = degradingEnum(
  ["ui", "calendar"],
  "ui",
);

export const override = z.object({
  id: uuid,
  type: overrideType,
  window_id: uuid.nullable().optional(),
  /** Null only when `type === "suspend"`; otherwise > 0. */
  minutes: z.int().positive().nullable().optional(),
  effective_date: calendarDate,
  /**
   * ⚠️ NOT optional, by design — the load-bearing constraint of the whole
   * system. There is nowhere to store "never expires", so no feature added
   * later can create a permanent relaxation, and a stale policy can only ever
   * converge stricter (§4.6, A.8, Invariant E).
   */
  expires_at: instant,
  granted_by: uuid.nullable().optional(),
  granted_via: grantedVia,
  reason: z.string().nullable().optional(),
});

export const overridePolicy = z.object({
  enabled: z.boolean().default(true),
  allowed_minutes: z.array(z.int().positive()).default([15, 30, 60]),
  max_minutes_per_day: z.int().positive().default(120),
  max_grants_per_day: z.int().positive().default(3),
});

export const expectedOnlineWindow = z.object({
  days: z.array(weekday).min(1),
  from: timeOfDay,
  until: timeOfDay,
});

export const telemetryPolicy = z.object({
  enabled: z.boolean().default(true),
  sample_interval_s: z.int().positive().default(60),
  flush_interval_s: z.int().positive().default(300),
  /** Glob patterns, e.g. `enforcement.*` — an open list, never an enum (R8). */
  collect: z.array(z.string()).default([]),
  max_queue_events: z.int().positive().default(50_000),
  max_queue_bytes: z.int().positive().default(33_554_432),
  max_queue_age_days: z.int().positive().default(14),
  audit_retention_days: z.int().positive().default(90),
});

export const policyDocument = z.object({
  /** Monotonic per device. The policy document carries no `contract` field. */
  policy_version: z.int(),
  issued_at: instant,
  not_before: instant,
  device_id: uuid,
  subject: z.object({ child_id: uuid, display_name: z.string() }),

  timezone,
  /**
   * ⚠️ `fail_mode` is deliberately ABSENT — X11 removed it. It lived inside the
   * signed document, so in exactly the two cases where fail-open applies (no
   * policy, corrupt policy) it cannot be read; its only reachable uses were
   * already unconditionally fail-closed. Fail behaviour is a compiled-in
   * invariant, not configuration. §4.3 still shows it and was never updated.
   */
  confirm_immediate_effect: z.boolean().default(false),

  poll: z
    .object({
      base_interval_s: z.int().positive().default(60),
      boundary_interval_s: z.int().positive().default(15),
      boundary_lead_s: z.int().positive().default(900),
    })
    .optional(),
  agent: z
    .object({
      log_level: z.string().default("info"),
      diagnostics_retention_days: z.int().positive().default(7),
    })
    .optional(),

  schedule,
  overrides: z.array(override).default([]),
  override_policy: overridePolicy.optional(),
  expected_online: z.array(expectedOnlineWindow).default([]),
  telemetry: telemetryPolicy.optional(),

  /**
   * Warn only, never behaviour. There is no `max_age_s` and there must not be
   * — X1c: a TTL that stops enforcement is a remotely-triggerable bypass.
   */
  staleness: z.object({ warn_after_s: z.int().positive().default(86_400) }).optional(),
});
export type PolicyDocument = z.infer<typeof policyDocument>;

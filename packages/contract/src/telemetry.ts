import { z } from "zod";

/**
 * The `data` shapes the PROJECTOR reads.
 *
 * ⚠️ These are not transport concerns. R8 is explicit that "the transport
 * knows the envelope and **nothing** about `data`" — ingest stores every
 * event verbatim, including types and shapes nothing here describes, and
 * `/events` never consults this file. That is what makes adding per-app
 * reporting later a backfill rather than a migration.
 *
 * But a projection has to interpret *something*, and the design document
 * defines no event's `data` anywhere — it names types in passing and stops.
 * So these are defined in phase 2 from what the projector actually needs,
 * exactly as the enrolment request body was.
 *
 * ⚠️ Read TOLERANTLY. An event whose `data` does not match is already stored
 * and stays stored; it simply contributes nothing to a rollup and is counted
 * as unprojectable. A future projection can reinterpret it from the JSONB
 * with no migration and no data loss. Nothing here may become a reason to
 * reject an event.
 */

/** `app.usage_sample` → `usage_hourly`. One frontmost app over one sample interval. */
export const appUsageSample = z.object({
  /** e.g. `com.apple.Safari`. The grouping key. */
  bundle_id: z.string().min(1),
  /** Seconds this app was frontmost during the sample. */
  foreground_s: z.number().nonnegative().optional(),
  /**
   * Seconds the user was actually present (A.33 — the meter).
   * Only one app is frontmost at a time, so these are DISJOINT across apps
   * and summing them over a day is correct, not an over-count.
   */
  active_s: z.number().nonnegative().optional(),
  /** Whole percent, 0–100+. Stored as basis points (×100) — the DB is an int. */
  cpu_pct: z.number().nonnegative().optional(),
});
export type AppUsageSample = z.infer<typeof appUsageSample>;

/** The four span kinds `session_spans.kind` records. */
export const SESSION_STATES = ["awake", "active", "locked", "asleep"] as const;

/** `session.state` → `session_spans`. A transition, not a duration. */
export const sessionStateSample = z.object({
  state: z.enum(SESSION_STATES),
  /** The logged-in user at the transition, when known. */
  console_user: z.string().nullable().optional(),
});
export type SessionStateSample = z.infer<typeof sessionStateSample>;

/**
 * Event types that become an `enforcement_log` row — "THIS IS THE PRODUCT,
 * what a parent means when they ask *but what actually happened?*".
 *
 * Maps a wire `type` to the `kind` the schema's comment enumerates. Anything
 * not listed is still stored in `events`; it just has no row in the log yet.
 *
 * ⚠️ `queue.evicted` is here deliberately. §5.7's first honesty rule: "Gaps
 * are data… zero usage and no data look identical on a bar chart and mean
 * opposite things." An eviction is the record that something was lost.
 */
export const ENFORCEMENT_LOG_KINDS: Readonly<Record<string, string>> = Object.freeze({
  "enforcement.warning_shown": "warning_shown",
  "enforcement.warning_failed": "warning_failed",
  "enforcement.action_taken": "action_taken",
  "enforcement.action_failed": "action_failed",
  "policy.applied": "policy_applied",
  "policy.rejected": "policy_rejected",
  "agent.degraded": "degraded",
  "agent.started": "agent_started",
  "agent.stopping": "agent_stopping",
  "clock.stepped": "clock_stepped",
  "override.granted": "override_granted",
  "override.expired": "override_expired",
  "queue.evicted": "queue_evicted",
  "agent.kill_switch_present": "kill_switch_present",
});

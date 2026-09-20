import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { tripwires } from "../db/schema.js";

/**
 * Tripwires — "cheap non-boundary signals" (§5.2).
 *
 * ⚠️ One row per `(device_id, kind)`, bumped rather than appended. §5.2 is
 * explicit about why: they surface as **ONE banner, never eight alerts**, and
 * under AR.1 deliberately never as a notification. The value is that the
 * history exists when someone later asks "has she ever tried?" — not that
 * anyone is paged.
 *
 * The spec lists nine kinds as a bare column comment and never says which
 * handler raises which, or on what comparison. `routes/sync.ts` implements the
 * seven computable from a sync body; the other two are recorded there as
 * deliberately absent.
 */

/** The nine kinds the schema comment names. Not all are raised — see sync.ts. */
export const TRIPWIRE_KINDS = [
  "hardware_uuid_mismatch",
  "unexpected_source_ip",
  "concurrent_boot_ids",
  "signature_invalid",
  "policy_version_regression",
  "network_time_disabled",
  "timezone_mismatch",
  "agent_stopped_while_up",
  "kill_switch_present",
] as const;

export type TripwireKind = (typeof TRIPWIRE_KINDS)[number];

export interface RaiseTripwireArgs {
  householdId: string;
  deviceId: string;
  kind: TripwireKind;
  /** Opaque context for the banner. Never interpreted. */
  detail?: Record<string, unknown>;
}

/**
 * Record a tripwire, or bump the one that is already there.
 *
 * `first_seen_at` keeps its original value on conflict — the question the table
 * answers is "since when", and overwriting it would erase exactly that.
 */
export async function raiseTripwire(
  args: RaiseTripwireArgs,
  tx: Pick<typeof db, "insert"> = db,
): Promise<void> {
  await tx
    .insert(tripwires)
    .values({
      householdId: args.householdId,
      deviceId: args.deviceId,
      kind: args.kind,
      detail: args.detail ?? null,
    })
    .onConflictDoUpdate({
      target: [tripwires.deviceId, tripwires.kind],
      set: {
        occurrences: sql`${tripwires.occurrences} + 1`,
        lastSeenAt: sql`now()`,
        detail: args.detail ?? null,
      },
    });
}

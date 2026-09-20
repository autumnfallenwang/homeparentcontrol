import { type Subject, tripwirePhrasing } from "@hpc/contract";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db/index.js";
import {
  children,
  devices,
  enforcementLog,
  overrides,
  policyVersions,
  tripwires,
  usageDaily,
} from "../db/schema.js";
import { isSoaking } from "../lib/soak.js";
import type { ParentVariables } from "./parent-context.js";

/**
 * `GET /api/parent/v1/today` — the `/` page, in one request.
 *
 * §5.8: "one card per device, health in plain language, tonight's boundary
 * with overrides folded in, today's screen time, **one** tripwire banner not
 * eight, and the 15/30/60 grant buttons right here because this is the page
 * open when the child asks".
 *
 * ⚠️ **One request, not six.** This page is opened in a hurry, on a phone, to
 * settle an argument that is happening right now. Every round trip is a
 * second of someone standing there.
 *
 * ⚠️ **It does NOT set `attended_until`.** That is a deliberate write and it
 * belongs to `/devices/:id` alone — see `parent-devices.ts`. Putting every
 * device into 5-second polling because a parent glanced at the home page
 * would multiply the household's request rate by twelve for ten minutes,
 * every time.
 */
export async function handleToday(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const now = new Date();

  const deviceRows = await db
    .select({
      id: devices.id,
      label: devices.label,
      status: devices.status,
      childId: devices.childId,
      childName: children.displayName,
      childTimezone: children.timezone,
      healthState: devices.healthState,
      healthReason: devices.healthReason,
      healthSince: devices.healthSince,
      lastSyncAt: devices.lastSyncAt,
      appliedPolicyVersion: devices.appliedPolicyVersion,
      attendedUntil: devices.attendedUntil,
      agentVersion: devices.agentVersion,
    })
    .from(devices)
    .leftJoin(children, eq(children.id, devices.childId))
    .where(eq(devices.householdId, householdId))
    .orderBy(devices.label);

  const cards = await Promise.all(
    deviceRows.map(async (device) => {
      const [usage, grants, boundary, banner, lastAction, soaking] = await Promise.all([
        todayUsage(device.id, device.childTimezone, now),
        activeGrants(device.id, device.childId, now),
        tonightsBoundary(device.id),
        loudestTripwire(device.id, {
          childName: device.childName ?? "your child",
          deviceLabel: device.label ?? "This Mac",
        }),
        lastEnforcement(device.id),
        // ★ §6.5 — a soaking device is deliberately NOT enforcing, and the
        // parent has to be told in those words. Fail-open is only
        // defensible while it is loud, and a silent soak is a Mac that
        // quietly stopped locking.
        isSoaking(device.id, now),
      ]);

      return {
        device_id: device.id,
        label: device.label,
        status: device.status,
        child: device.childId
          ? { id: device.childId, display_name: device.childName, timezone: device.childTimezone }
          : null,
        health: {
          state: device.healthState,
          reason: device.healthReason,
          since: device.healthSince?.toISOString() ?? null,
          last_sync_at: device.lastSyncAt?.toISOString() ?? null,
          // ⚠️ The UI needs BOTH — how long it has been quiet, and which day
          // the rules it is still enforcing came from. §4.6's sentence names
          // the second, and getting it from `last_sync_at` would be wrong:
          // the rules in force are the last ones it APPLIED.
          silent_for_s: device.lastSyncAt
            ? Math.max(0, Math.round((now.getTime() - device.lastSyncAt.getTime()) / 1000))
            : null,
          applied_policy_version: device.appliedPolicyVersion,
          applied_policy_at: boundary.appliedAt,
        },
        attended_until: device.attendedUntil?.toISOString() ?? null,
        agent_version: device.agentVersion,
        tonight: boundary.tonight,
        // Live grants, so the card can say "bedtime 21:30 → 22:00 tonight".
        active_grants: grants,
        usage_today: usage,
        // ★ ONE banner, not eight.
        banner,
        shadow_mode: soaking,
        last_enforcement: lastAction,
      };
    }),
  );

  return c.json({ generated_at: now.toISOString(), devices: cards });
}

/** Today's rollup, in the CHILD's timezone — never the server's. */
async function todayUsage(deviceId: string, timezone: string | null, now: Date) {
  const zone = timezone ?? "UTC";
  const localDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const rows = await db
    .select({
      bundleId: usageDaily.bundleId,
      foregroundS: usageDaily.foregroundS,
      activeS: usageDaily.activeS,
    })
    .from(usageDaily)
    .where(and(eq(usageDaily.deviceId, deviceId), eq(usageDaily.localDay, localDay)));

  const top = [...rows].sort((a, b) => b.activeS - a.activeS).slice(0, 5);
  return {
    local_day: localDay,
    // ★ `active_s` is the meter (A.33), and the UI labels it with
    // ACTIVE_TIME_EXPLANATION — "not minutes it was switched on".
    active_s: rows.reduce((sum, row) => sum + row.activeS, 0),
    foreground_s: rows.reduce((sum, row) => sum + row.foregroundS, 0),
    // ⚠️ Distinguishable from "no data": an empty array with a reporting
    // device means she did not use it. §5.7's first honesty rule.
    top_apps: top.map((row) => ({
      bundle_id: row.bundleId,
      active_s: row.activeS,
      foreground_s: row.foregroundS,
    })),
  };
}

/** Live relaxations, so the card shows the boundary the agent will actually use. */
async function activeGrants(deviceId: string, childId: string | null, now: Date) {
  if (!childId) return [];
  const rows = await db
    .select({
      id: overrides.id,
      type: overrides.type,
      minutes: overrides.minutes,
      expiresAt: overrides.expiresAt,
      effectiveDate: overrides.effectiveDate,
      reason: overrides.reason,
    })
    .from(overrides)
    .where(
      and(
        eq(overrides.childId, childId),
        isNull(overrides.revokedAt),
        gt(overrides.expiresAt, now),
        // A device-scoped grant, or a child-wide one.
        sql`(${overrides.deviceId} IS NULL OR ${overrides.deviceId} = ${deviceId})`,
      ),
    )
    .orderBy(desc(overrides.createdAt));

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    minutes: row.minutes,
    effective_date: row.effectiveDate,
    expires_at: row.expiresAt.toISOString(),
    reason: row.reason,
  }));
}

/**
 * Tonight's boundary, read out of the COMPILED policy.
 *
 * ⚠️ Not recomputed from `schedule_windows`. The compiled document is what
 * the agent obeys — it has the holidays, the exceptions and the grants
 * already folded in — so a second derivation here would be a second
 * implementation of the compiler, drifting quietly.
 */
async function tonightsBoundary(deviceId: string) {
  const [version] = await db
    .select({
      version: policyVersions.version,
      document: policyVersions.document,
      issuedAt: policyVersions.issuedAt,
    })
    .from(policyVersions)
    .where(and(eq(policyVersions.deviceId, deviceId), lt(policyVersions.notBefore, sql`now()`)))
    .orderBy(desc(policyVersions.version))
    .limit(1);

  if (!version) return { tonight: null, appliedAt: null };

  const document = version.document as {
    schedule?: {
      windows?: {
        label?: string;
        days?: string[];
        restricted_from?: string;
        restricted_until?: string;
        action?: string;
      }[];
    };
  };
  const windows = document.schedule?.windows ?? [];

  return {
    appliedAt: version.issuedAt?.toISOString() ?? null,
    tonight: {
      policy_version: version.version,
      windows: windows.map((window) => ({
        label: window.label ?? null,
        days: window.days ?? [],
        restricted_from: window.restricted_from ?? null,
        restricted_until: window.restricted_until ?? null,
        action: window.action ?? null,
      })),
    },
  };
}

/**
 * ★ ONE banner, not eight.
 *
 * §5.8 is explicit. Eight simultaneous banners is the same as none: the
 * parent learns to scroll past the block. The loudest open tripwire wins and
 * the rest are a count.
 */
async function loudestTripwire(deviceId: string, subject: Subject) {
  // ⚠️ "Open" means UNACKNOWLEDGED. The table has no `resolved_at` on
  // purpose — a tripwire is a historical fact ("has she ever tried?"), so it
  // is dismissed by the parent, never cleared by the system.
  const rows = await db
    .select({
      id: tripwires.id,
      kind: tripwires.kind,
      firstSeenAt: tripwires.firstSeenAt,
      lastSeenAt: tripwires.lastSeenAt,
      occurrences: tripwires.occurrences,
    })
    .from(tripwires)
    .where(and(eq(tripwires.deviceId, deviceId), isNull(tripwires.acknowledgedAt)))
    .orderBy(desc(tripwires.lastSeenAt));

  if (rows.length === 0) return null;

  // Severity comes from the KIND, via the shared phrasing — the table stores
  // no summary, deliberately, so that wording can be improved without a
  // migration and without rewriting history.
  const order: Record<string, number> = { alarm: 0, warn: 1, info: 2 };
  const rank = (kind: string) => order[tripwirePhrasing(kind, subject).severity] ?? 3;
  const ranked = [...rows].sort((a, b) => rank(a.kind) - rank(b.kind));
  const loudest = ranked[0];
  if (!loudest) return null;
  const phrasing = tripwirePhrasing(loudest.kind, subject);

  return {
    id: loudest.id,
    kind: loudest.kind,
    severity: phrasing.severity,
    summary: phrasing.summary,
    benign: phrasing.benign,
    first_seen_at: loudest.firstSeenAt?.toISOString() ?? null,
    last_seen_at: loudest.lastSeenAt?.toISOString() ?? null,
    occurrences: loudest.occurrences,
    // "and 3 others" — the count, never the list.
    also_open: rows.length - 1,
  };
}

/**
 * The most recent thing that actually happened to the child.
 *
 * ⚠️ Needed by the grant flow: if enforcement has already fired, the UI shows
 * the §3.5 sentence — a late grant does not unlock the Mac.
 */
async function lastEnforcement(deviceId: string) {
  const [row] = await db
    .select({
      kind: enforcementLog.kind,
      summary: enforcementLog.summary,
      occurredAt: enforcementLog.occurredAt,
    })
    .from(enforcementLog)
    .where(eq(enforcementLog.deviceId, deviceId))
    .orderBy(desc(enforcementLog.occurredAt))
    .limit(1);

  if (!row) return null;
  return {
    kind: row.kind,
    summary: row.summary,
    at: row.occurredAt.toISOString(),
    // The UI decides whether to show the no-unlock sentence from this.
    is_locked_now: row.kind === "action_taken",
  };
}

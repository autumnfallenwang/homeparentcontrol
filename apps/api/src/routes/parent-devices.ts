import { and, desc, eq, gte, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  agentStatusIntervals,
  apikeys,
  children,
  desiredItems,
  devices,
  enrollments,
  sessionSpans,
  tripwires,
} from "../db/schema.js";
import { loadHistory } from "../lib/history.js";
import { log } from "../lib/logger.js";
import { soakReport } from "../lib/soak.js";
import { fail, type ParentVariables } from "./parent-context.js";

/**
 * `/devices/[id]` — the device page, and the mechanism behind the 5-second
 * grant.
 */

/** §4.2: "a server-side 10-minute sticky flag". */
export const ATTENDED_WINDOW_MS = 10 * 60 * 1000;

/**
 * `POST /api/parent/v1/devices/:id/attend`
 *
 * ⚠️ **A POST, not a side effect of the GET, and this is not pedantry.**
 *
 * §5.8 says "opening it sets `attendedUntil = now() + 10 min`". Implemented
 * literally — as a write inside `GET /devices/:id` — that fires on Next.js
 * link prefetch, on a browser's speculative load, on a monitoring probe and
 * on every refresh of a page left open on a kitchen tablet. Each one puts the
 * device into 5-second polling for ten minutes: twelve times the request
 * rate, triggered by nobody looking at anything.
 *
 * The page calls this explicitly on mount. Same effect when a human opens the
 * page, no effect when a machine does.
 */
export async function handleAttend(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const deviceId = c.req.param("id");
  if (!deviceId) return fail(c, 400, "missing device id");

  const until = new Date(Date.now() + ATTENDED_WINDOW_MS);
  const updated = await db
    .update(devices)
    .set({ attendedUntil: until })
    .where(and(eq(devices.id, deviceId), eq(devices.householdId, householdId)))
    .returning({ id: devices.id });

  if (updated.length === 0) return fail(c, 404, "no such device");
  return c.json({ attended_until: until.toISOString() });
}

/** `GET /api/parent/v1/devices/:id` — read-only, so it is safe to prefetch. */
export async function handleDevice(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const deviceId = c.req.param("id");
  if (!deviceId) return fail(c, 400, "missing device id");

  const [device] = await db
    .select({
      id: devices.id,
      label: devices.label,
      status: devices.status,
      childId: devices.childId,
      childName: children.displayName,
      childTimezone: children.timezone,
      hardwareUuid: devices.hardwareUuid,
      hostname: devices.hostname,
      model: devices.model,
      osVersion: devices.osVersion,
      arch: devices.arch,
      agentVersion: devices.agentVersion,
      healthState: devices.healthState,
      healthReason: devices.healthReason,
      healthSince: devices.healthSince,
      lastSyncAt: devices.lastSyncAt,
      lastBootId: devices.lastBootId,
      systemBootTime: devices.systemBootTime,
      appliedPolicyVersion: devices.appliedPolicyVersion,
      selfReportedReason: devices.selfReportedReason,
      attendedUntil: devices.attendedUntil,
      awayUntil: devices.awayUntil,
    })
    .from(devices)
    .leftJoin(children, eq(children.id, devices.childId))
    .where(and(eq(devices.id, deviceId), eq(devices.householdId, householdId)))
    .limit(1);

  if (!device) return fail(c, 404, "no such device");

  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [timeline, spans, recent, wires, pending] = await Promise.all([
    // §5.8's "7-day state timeline".
    db
      .select({
        state: agentStatusIntervals.state,
        reason: agentStatusIntervals.reason,
        enteredAt: agentStatusIntervals.enteredAt,
        exitedAt: agentStatusIntervals.exitedAt,
        reclassifiedFrom: agentStatusIntervals.reclassifiedFrom,
      })
      .from(agentStatusIntervals)
      .where(
        and(
          eq(agentStatusIntervals.deviceId, deviceId),
          gte(agentStatusIntervals.enteredAt, weekAgo),
        ),
      )
      .orderBy(desc(agentStatusIntervals.enteredAt)),
    db
      .select({
        kind: sessionSpans.kind,
        startedAt: sessionSpans.startedAt,
        endedAt: sessionSpans.endedAt,
      })
      .from(sessionSpans)
      .where(and(eq(sessionSpans.deviceId, deviceId), gte(sessionSpans.startedAt, weekAgo)))
      .orderBy(desc(sessionSpans.startedAt))
      .limit(500),
    // No upper bound on purpose: a Mac whose clock runs ahead stamps its rows
    // in the future, and hiding them would hide the evidence.
    loadHistory({ householdId, deviceId, from: weekAgo, limit: 1_000 }),
    db
      .select({
        id: tripwires.id,
        kind: tripwires.kind,
        firstSeenAt: tripwires.firstSeenAt,
        lastSeenAt: tripwires.lastSeenAt,
        occurrences: tripwires.occurrences,
        acknowledgedAt: tripwires.acknowledgedAt,
        detail: tripwires.detail,
      })
      .from(tripwires)
      .where(eq(tripwires.deviceId, deviceId))
      .orderBy(desc(tripwires.lastSeenAt)),
    db
      .select({ id: desiredItems.id, kind: desiredItems.kind, status: desiredItems.status })
      .from(desiredItems)
      .where(eq(desiredItems.deviceId, deviceId)),
  ]);

  return c.json({
    device: {
      id: device.id,
      label: device.label,
      status: device.status,
      child: device.childId
        ? { id: device.childId, display_name: device.childName, timezone: device.childTimezone }
        : null,
      hardware_uuid: device.hardwareUuid,
      hostname: device.hostname,
      model: device.model,
      os_version: device.osVersion,
      arch: device.arch,
      agent_version: device.agentVersion,
      applied_policy_version: device.appliedPolicyVersion,
      attended_until: device.attendedUntil?.toISOString() ?? null,
      // X6/A.19 — "Away until…", the only legitimate way to silence the
      // offline alarm, and it has an end date by construction.
      away_until: device.awayUntil?.toISOString() ?? null,
    },
    health: {
      state: device.healthState,
      reason: device.healthReason,
      since: device.healthSince?.toISOString() ?? null,
      last_sync_at: device.lastSyncAt?.toISOString() ?? null,
      self_reported_reason: device.selfReportedReason,
    },
    // §5.8's "clock posture" — the boot identity and time basis, which is
    // what a parent needs when the question is "has the clock been moved?"
    clock: {
      last_boot_id: device.lastBootId,
      system_boot_time: device.systemBootTime?.toISOString() ?? null,
    },
    timeline: timeline.map((row) => ({
      state: row.state,
      reason: row.reason,
      entered_at: row.enteredAt.toISOString(),
      exited_at: row.exitedAt?.toISOString() ?? null,
      // ⚠️ Kept visible. A silence later reclassified as expected is a
      // different story from one that was expected all along, and hiding the
      // reclassification would make the timeline quietly retroactive.
      reclassified_from: row.reclassifiedFrom,
    })),
    session_spans: spans.map((row) => ({
      kind: row.kind,
      started_at: row.startedAt.toISOString(),
      ended_at: row.endedAt?.toISOString() ?? null,
    })),
    enforcement: recent.rows.map((row) => ({
      kind: row.kind,
      summary: row.summary,
      at: row.at,
      policy_version: row.policyVersion,
      tone: row.tone,
    })),
    tripwires: wires.map((row) => ({
      id: row.id,
      kind: row.kind,
      first_seen_at: row.firstSeenAt?.toISOString() ?? null,
      last_seen_at: row.lastSeenAt?.toISOString() ?? null,
      occurrences: row.occurrences,
      acknowledged_at: row.acknowledgedAt?.toISOString() ?? null,
      detail: row.detail,
    })),
    desired: pending,
  });
}

/**
 * `GET /api/parent/v1/devices/:id/soak` — §6.5's shadow-mode soak.
 *
 * ⚠️ **Read-only and advisory.** Nothing here can extend a soak: the agent's
 * deadline is baked into its own marker at install and the server cannot
 * move it. A broken report can only fail to promote early, and the deadline
 * still ends the soak — which is the direction Invariant E requires.
 */
export async function handleSoak(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const deviceId = c.req.param("id");
  if (!deviceId) return fail(c, 400, "missing device id");

  const [device] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.householdId, householdId)))
    .limit(1);
  if (!device) return fail(c, 404, "no such device");

  return c.json(await soakReport(deviceId));
}

// ── Away until (X6 / A.19)

const awayBody = z.object({
  /** ⚠️ Mandatory. There is no indefinite "away" — that would be a mute. */
  until: z.iso.datetime(),
});

/**
 * `POST /api/parent/v1/devices/:id/away`
 *
 * ⚠️ **`away_until` silences the OFFLINE alarm and nothing else.** It does
 * not stop enforcement, does not pause the policy, and cannot be indefinite.
 * A holiday is the case it exists for: a Mac that is legitimately off for a
 * week should not page anyone, and the alternative — a parent turning
 * notifications off — never gets turned back on.
 */
export async function handleAway(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const deviceId = c.req.param("id");
  if (!deviceId) return fail(c, 400, "missing device id");
  const parsed = awayBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, "expected { until: ISO-8601 }");

  const until = new Date(parsed.data.until);
  if (until <= new Date()) return fail(c, 422, "`until` must be in the future");
  // A year is not a holiday; it is a mute with extra steps.
  if (until.getTime() - Date.now() > 90 * 86_400_000) {
    return fail(c, 422, "`until` may be at most 90 days out");
  }

  const updated = await db
    .update(devices)
    .set({ awayUntil: until })
    .where(and(eq(devices.id, deviceId), eq(devices.householdId, householdId)))
    .returning({ id: devices.id });
  if (updated.length === 0) return fail(c, 404, "no such device");

  return c.json({ away_until: until.toISOString() });
}

// ── Revoke and Decommission (§5.5)

const confirmBody = z.object({ confirm: z.string() });

/**
 * `POST /api/parent/v1/devices/:id/revoke`
 *
 * > **Revoke** — the Mac stops talking to the server **but keeps enforcing
 * > bedtime**. Use this if you think the credential leaked.
 *
 * ⚠️ The credential dies; enforcement does not (X1b). The agent gets a 401,
 * maps it to `halt_sync_keep_enforcing`, and goes on applying the policy it
 * has — for ever, because a cached policy never expires (X1c).
 */
export async function handleRevoke(c: Context<{ Variables: ParentVariables }>) {
  return endCredential(c, {
    action: "revoke",
    confirmWord: "REVOKE",
    status: "revoked",
    dropDesired: false,
  });
}

/**
 * `POST /api/parent/v1/devices/:id/decommission`
 *
 * > **Decommission** — the agent uninstalls itself and **stops enforcing
 * > anything**. Use this when the Mac is leaving the house.
 *
 * ⚠️ **The one sanctioned way to stop enforcement** (A.7). It is authenticated
 * and parent-initiated, which is exactly the guard: the device learns of it
 * as a `410` on its next `/sync`, and the agent honours `410` from `/sync`
 * alone.
 *
 * ⚠️ **All telemetry is retained** — "the child's history is not the device's
 * property".
 *
 * ⚠️ **The credential stays ALIVE.** This used to disable it exactly as revoke
 * does — so the Mac's next `/sync` failed authentication, got a bare 401,
 * mapped it to `halt_sync_keep_enforcing`, and never heard the one answer
 * that uninstalls it. Decommission ended nothing, and nothing said so. Found
 * on the first real decommission (2026-09-28): 200 here, then 401 on the very
 * next sync, and the agent still fully installed four minutes later. The
 * credential is retired by `/events` when the agent's final
 * `agent.decommissioned` report arrives.
 */
export async function handleDecommission(c: Context<{ Variables: ParentVariables }>) {
  return endCredential(c, { action: "decommission", confirmWord: "DECOMMISSION", ...DECOMMISSION });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface EndOptions {
  status: string;
  dropDesired: boolean;
  /** Decommission only: the device must still authenticate to be told. */
  keepCredential?: boolean;
}

/** What Decommission does to a device — and so what removing its child does to each one. */
export const DECOMMISSION: EndOptions = {
  status: "decommissioned",
  dropDesired: true,
  keepCredential: true,
};

/**
 * End one device, inside the caller's transaction. One function for both
 * endpoints and for removing a child, so the three cannot drift apart.
 */
export async function endDevice(
  tx: Tx,
  device: { id: string; apiKeyId: string | null; previous: string | null },
  opts: EndOptions,
) {
  if (!opts.keepCredential) {
    // Both keys — the current one and any inside a rotation overlap.
    for (const keyId of [device.apiKeyId, device.previous].filter(Boolean) as string[]) {
      await tx.update(apikeys).set({ enabled: false }).where(eq(apikeys.id, keyId));
    }
  }
  await tx
    .update(devices)
    .set({
      status: opts.status,
      // Kept while the credential lives: the agent may be mid-rotation.
      ...(opts.keepCredential ? {} : { previousApiKeyId: null, previousApiKeyExpiresAt: null }),
    })
    .where(eq(devices.id, device.id));

  // ★ And its unused setup code dies with it. The claim never looks at the
  // device's status, so a removed device that was never set up came back as
  // `enrolled` the moment anyone pasted its old install command.
  await tx
    .delete(enrollments)
    .where(and(eq(enrollments.deviceId, device.id), isNull(enrollments.consumedAt)));

  if (opts.dropDesired) {
    // "every `desired_items` row dropped" — nothing should hand a retired
    // device new work.
    await tx.delete(desiredItems).where(eq(desiredItems.deviceId, device.id));
  }
}

async function endCredential(
  c: Context<{ Variables: ParentVariables }>,
  opts: EndOptions & { action: "revoke" | "decommission"; confirmWord: string },
) {
  const householdId = c.get("householdId");
  const user = c.get("user");
  const deviceId = c.req.param("id");
  if (!deviceId) return fail(c, 400, "missing device id");

  const parsed = confirmBody.safeParse(await c.req.json().catch(() => null));
  // ⚠️ §5.5: "the UI must make these typed-confirmation actions". Enforced
  // on the SERVER too — a confirmation only the browser checks is a
  // confirmation anyone can skip with curl, and one of these two uninstalls
  // a child's bedtime.
  if (!parsed.success || parsed.data.confirm !== opts.confirmWord) {
    return fail(c, 422, `type ${opts.confirmWord} to confirm`);
  }

  const [device] = await db
    .select({ id: devices.id, apiKeyId: devices.apiKeyId, previous: devices.previousApiKeyId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.householdId, householdId)))
    .limit(1);
  if (!device) return fail(c, 404, "no such device");

  await db.transaction((tx) => endDevice(tx, device, opts));

  log.warn(
    { event: `device.${opts.action}`, action: opts.action, device_id: device.id, by: user.id },
    "device ended by a parent",
  );

  return c.json({
    device_id: device.id,
    status: opts.status,
    // ⚠️ Said back to the UI so the confirmation screen cannot claim the
    // wrong outcome. Revoke keeps enforcing; decommission does not.
    stops_enforcement: opts.action === "decommission",
  });
}

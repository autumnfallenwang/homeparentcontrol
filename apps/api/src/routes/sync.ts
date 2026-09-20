import {
  CONTRACT_MINOR,
  type PolicyDocument,
  type SyncRequest,
  type SyncResponse,
  syncRequest,
} from "@hpc/contract";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db/index.js";
import { desiredItems, devices, policySets, policyVersions } from "../db/schema.js";
import { negotiate } from "../lib/capabilities.js";
import { log } from "../lib/logger.js";
import { ProblemError } from "../lib/problem.js";
import { raiseTripwire, type TripwireKind } from "../lib/tripwires.js";

/**
 * `POST /api/agent/v1/sync` — the tick, and the heartbeat (§4.2).
 *
 * ⚠️ A.26: there is no `/heartbeat` endpoint, ever. `policy_state`,
 * `enforcement`, `clock` and `queue` ride here rather than on `/events`
 * because `DEGRADED` is computed from them — if they travelled on the
 * telemetry channel then in exactly the situation where telemetry is backed up
 * or being rejected, the control plane would lose the ability to compute
 * health, and a device reporting "I cannot read my policy" would be
 * indistinguishable from a healthy one.
 */

/**
 * ⚠️ The agent clamps to this range; so do we. §4.2 states the clamp only as
 * the agent's, which leaves a server bug emitting `0` or a negative defended
 * against solely by the client.
 */
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 300_000;

/**
 * ⚠️ Prose-only constants. `poll{}` carries `base_interval_s`,
 * `boundary_interval_s` and `boundary_lead_s` as real columns, but the
 * `attended` interval and its sticky window appear nowhere except one sentence
 * in §4.2 ("a server-side 10-minute sticky flag"). `devices.attended_until` is
 * the flag; these are the numbers behind it.
 */
const ATTENDED_INTERVAL_MS = 5_000;

/** How the cadence was chosen, for the log line. §4.2's four modes. */
type Cadence = "base" | "boundary" | "attended";

export async function handleSync(c: Context): Promise<Response> {
  const deviceId = c.get("deviceId") as string;

  const parsed = syncRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    // 400 → drop_batch. The agent discards this tick's payload and retries;
    // nothing about enforcement changes.
    throw new ProblemError("malformed", parsed.error.issues[0]?.message);
  }
  const body = parsed.data;

  // §5.9 — "every agent handler must re-check that the key's device_id matches
  // the device_id in the body". Scope is the actual security control here, not
  // the transport (X4).
  if (body.device.device_id !== deviceId) {
    throw new ProblemError("scopeViolation", "device_id does not match the presented credential");
  }

  const [device] = await db
    .select({
      householdId: devices.householdId,
      status: devices.status,
      policySetId: devices.policySetId,
      hardwareUuid: devices.hardwareUuid,
      systemBootTime: devices.systemBootTime,
      appliedPolicyVersion: devices.appliedPolicyVersion,
      attendedUntil: devices.attendedUntil,
    })
    .from(devices)
    .where(eq(devices.id, deviceId));
  if (!device) throw new ProblemError("scopeViolation", "device not found");

  await recordTripwires(body, deviceId, device);
  await applyConvergence(body, deviceId);

  // ⚠️ Observations only. `health_state`, `health_reason` and `health_since`
  // belong to the 60-second liveness job (§7.3) — §5.2's claim that the sync
  // handler writes them too would give three columns two writers on two
  // different cadences. One writer per column; the liveness job is step 5.
  await db
    .update(devices)
    .set({
      lastSyncAt: sql`now()`,
      lastTickSeq: body.agent.tick_seq,
      lastBootId: body.device.boot_id,
      systemBootTime: new Date(body.device.system_boot_time),
      agentVersion: body.device.agent_version,
      osVersion: body.device.os_version,
      arch: body.device.arch,
      appliedPolicyVersion: body.policy_state.policy_version ?? null,
      // "`enrolled` means credential issued, never seen; `active` means it has
      // actually ticked" (§5.5).
      ...(device.status === "enrolled" ? { status: "active" as const } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(devices.id, deviceId));

  const policy = await policyEnvelope(deviceId, body.policy_state.etag ?? null);
  const desired = await pendingDesired(deviceId, body.agent.capabilities);
  const { ms: nextPollAfterMs, cadence } = await nextPoll(body, device);

  log.info(
    {
      event: "agent.sync",
      device_id: deviceId,
      tick_seq: body.agent.tick_seq,
      cadence,
      next_poll_after_ms: nextPollAfterMs,
      policy: policy?.unchanged === true ? "unchanged" : policy ? "sent" : "none",
      desired: desired.length,
    },
    "tick",
  );

  const response: SyncResponse = {
    contract: CONTRACT_MINOR,
    server_time: new Date().toISOString(),
    // The administrative lifecycle, which is what §4.2's `"active"` example is.
    // ⚠️ `revoked` and `decommissioned` are unreachable in a 200 body — they
    // produce 401 and 410 before this point.
    device_status: device.status === "enrolled" ? "active" : device.status,
    ...(policy ? { policy } : {}),
    desired,
    next_poll_after_ms: nextPollAfterMs,
    // R4 — send this device only what it said it understands.
    server_capabilities: negotiate(body.agent.capabilities),
  };
  return c.json(response);
}

type DeviceRow = {
  householdId: string;
  hardwareUuid: string | null;
  systemBootTime: Date | null;
  appliedPolicyVersion: number | null;
};

/**
 * The seven tripwires computable from a sync body.
 *
 * ⚠️ TWO of the schema's nine kinds are deliberately NOT raised here.
 * `unexpected_source_ip` needs a baseline of known addresses that no table
 * holds, and `concurrent_boot_ids` has no definition anywhere that separates
 * it from `agent_stopped_while_up`. Guessing at either would produce a banner
 * the parent cannot act on, which is worse than no banner.
 */
async function recordTripwires(
  body: SyncRequest,
  deviceId: string,
  device: DeviceRow,
): Promise<void> {
  const raise = (kind: TripwireKind, detail: Record<string, unknown>) =>
    raiseTripwire({ householdId: device.householdId, deviceId, kind, detail });

  const pending: Promise<void>[] = [];

  if (device.hardwareUuid && device.hardwareUuid !== body.device.hardware_uuid) {
    pending.push(
      raise("hardware_uuid_mismatch", {
        known: device.hardwareUuid,
        reported: body.device.hardware_uuid,
      }),
    );
  }

  if (body.clock.using_network_time === false) {
    pending.push(raise("network_time_disabled", { skew_ms: body.clock.skew_estimate_ms }));
  }

  // A.30 — the system zone is reported, never an input. A mismatch is worth
  // knowing about precisely because it changes nothing.
  if (body.clock.system_timezone !== body.clock.policy_timezone) {
    pending.push(
      raise("timezone_mismatch", {
        system: body.clock.system_timezone,
        policy: body.clock.policy_timezone,
      }),
    );
  }

  if (body.policy_state.signature_valid === false) {
    pending.push(raise("signature_invalid", { using_lkg: body.policy_state.using_lkg ?? null }));
  }

  if (body.agent.kill_switch != null) {
    pending.push(raise("kill_switch_present", { value: body.agent.kill_switch }));
  }

  const reported = body.policy_state.policy_version;
  if (
    typeof reported === "number" &&
    device.appliedPolicyVersion !== null &&
    reported < device.appliedPolicyVersion
  ) {
    pending.push(
      raise("policy_version_regression", { was: device.appliedPolicyVersion, now: reported }),
    );
  }

  // §7.4's strongest available tell: something issued a clean stop while the
  // machine stayed up. A reboot explains a clean exit; an unchanged boot time
  // does not.
  const bootTime = new Date(body.device.system_boot_time).getTime();
  if (
    body.agent.clean_exit_previous_run &&
    device.systemBootTime !== null &&
    device.systemBootTime.getTime() === bootTime
  ) {
    pending.push(
      raise("agent_stopped_while_up", {
        previous_stop_reason: body.agent.previous_stop_reason ?? null,
      }),
    );
  }

  await Promise.all(pending);
}

/**
 * Desired-state convergence (§4.5, R6).
 *
 * ⚠️ `converged[]` is a CLAIM, and §4.5 says "the server removes an item when
 * it observes convergence, not when the agent claims it" — which leaves the
 * array with no stated purpose at all. The only reading that makes it live
 * code: it is the transport for `unsupported`, which R6 requires the server to
 * record and treat as terminal. Claims of `converged` are ignored.
 *
 * `agent_version` is the one kind this handler can observe for itself —
 * "converged when the device reports a matching `device.agent_version`".
 * `diagnostics` and `self_test` converge when their event arrives on
 * `/events`; `credential` when a rotated key is actually used. Both deferred.
 */
async function applyConvergence(body: SyncRequest, deviceId: string): Promise<void> {
  for (const report of body.converged) {
    if (report.status !== "unsupported") continue; // a claim we do not act on
    await db
      .update(desiredItems)
      .set({
        status: "unsupported",
        unsupportedDetail: report.detail ?? null,
        observedAt: sql`now()`,
      })
      .where(and(eq(desiredItems.id, report.desired_id), eq(desiredItems.deviceId, deviceId)));
  }

  // The server's own observation, which is the only kind that counts.
  await db
    .update(desiredItems)
    .set({ status: "converged", observedAt: sql`now()` })
    .where(
      and(
        eq(desiredItems.deviceId, deviceId),
        eq(desiredItems.kind, "agent_version"),
        eq(desiredItems.status, "pending"),
        sql`${desiredItems.spec}->>'version' = ${body.device.agent_version}`,
      ),
    );
}

/**
 * ⚠️ NOT filtered by `agent.capabilities`.
 *
 * R4 says the server sends a device only what it advertised; R6 says an
 * unknown kind must come back as `unsupported`, terminal. Pre-filtering here
 * would satisfy R4 and make R6 unreachable — the item would silently never
 * ship and nobody would learn the device cannot do it. R4 is applied to
 * `server_capabilities` instead, which is what it is actually about. The
 * mismatch gets logged so it is visible either way.
 */
async function pendingDesired(
  deviceId: string,
  capabilities: readonly string[],
): Promise<SyncResponse["desired"]> {
  const rows = await db
    .select({ id: desiredItems.id, kind: desiredItems.kind, spec: desiredItems.spec })
    .from(desiredItems)
    .where(and(eq(desiredItems.deviceId, deviceId), eq(desiredItems.status, "pending")));

  const claimed = new Set(capabilities);
  for (const row of rows) {
    if (!claimed.has(`desired.${row.kind}`)) {
      log.info(
        { event: "agent.desired_unadvertised", device_id: deviceId, kind: row.kind },
        "sending a desired item the device did not advertise; expect `unsupported`",
      );
    }
  }

  return rows.map((row) => ({ desired_id: row.id, kind: row.kind, spec: row.spec }));
}

/**
 * The policy envelope (§4.2).
 *
 * ⚠️ The comparison rule is never written down. `If-None-Match` appears once
 * in the whole document and it is about `GET /policy`; here the ETag rides in
 * the request body, because the tick is a POST carrying telemetry and
 * conditional-GET semantics do not apply to it.
 */
async function policyEnvelope(
  deviceId: string,
  reportedEtag: string | null,
): Promise<SyncResponse["policy"]> {
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

  // Nothing compiled. `policy` is optional, so say nothing rather than invent
  // an empty envelope — §5.5 compiles v1 during enrolment so this is rare.
  if (!current) return undefined;

  if (reportedEtag && reportedEtag === current.etag) {
    return { unchanged: true, etag: current.etag, policy_version: current.version };
  }

  const base = { unchanged: false as const, etag: current.etag, policy_version: current.version };
  if (current.jws) return { ...base, jws: current.jws };

  // The column is `jsonb`, so drizzle types it `unknown`. `publish.ts` only
  // ever writes a document that has already been through
  // `policyDocument.parse`, so this is the one place the cast is warranted.
  return { ...base, document: current.document as PolicyDocument };
}

/**
 * The adaptive cadence (§4.2). "The agent has exactly one timer; everything
 * below is that timer changing its period. The server owns it."
 *
 * ⚠️ `boundary` is computed from the AGENT's reported `next_boundary_at`. The
 * server has the windows but no boundary resolver, and building one would mean
 * a second DST-correct implementation — skipped-hour and ambiguous-hour rules —
 * duplicating what the Swift agent must do in phase 3, free to drift against
 * it. §4.2 already grants the agent authority to shorten its own interval, so
 * trusting its report moves no new authority, and cadence is not a safety
 * control: enforcement is a separate daemon on an unconditional 60 s tick. The
 * worst a lying agent achieves is polling more often.
 */
async function nextPoll(
  body: SyncRequest,
  device: { policySetId: string | null; attendedUntil: Date | null },
): Promise<{ ms: number; cadence: Cadence }> {
  let base = 60_000;
  let boundaryInterval = 15_000;
  let boundaryLead = 900_000;

  if (device.policySetId) {
    const [set] = await db
      .select({
        base: policySets.pollBaseIntervalS,
        boundary: policySets.pollBoundaryIntervalS,
        lead: policySets.pollBoundaryLeadS,
      })
      .from(policySets)
      .where(eq(policySets.id, device.policySetId));
    if (set) {
      base = set.base * 1000;
      boundaryInterval = set.boundary * 1000;
      boundaryLead = set.lead * 1000;
    }
  }

  const now = Date.now();

  // The parent has the device page open — the 5-second grant.
  if (device.attendedUntil && device.attendedUntil.getTime() > now) {
    return { ms: clampPoll(ATTENDED_INTERVAL_MS), cadence: "attended" };
  }

  const boundaryAt = body.enforcement.next_boundary_at;
  if (boundaryAt) {
    const until = new Date(boundaryAt).getTime() - now;
    if (until > 0 && until <= boundaryLead) {
      return { ms: clampPoll(boundaryInterval), cadence: "boundary" };
    }
  }

  return { ms: clampPoll(base), cadence: "base" };
}

function clampPoll(ms: number): number {
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(ms)));
}

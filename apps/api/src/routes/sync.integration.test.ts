import { randomUUID } from "node:crypto";
import { CONTRACT_MINOR, type SyncRequest } from "@hpc/contract";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closeDb, db } from "../db/index.js";
import {
  children,
  desiredItems,
  devices,
  households,
  policySets,
  policyVersions,
  scheduleWindows,
  tripwires,
  users,
} from "../db/schema.js";
import { mintDeviceKey } from "../lib/device-keys.js";
import { publishPolicy } from "../policy/publish.js";

/**
 * `POST /sync` — the tick. Against real Postgres, because almost everything it
 * does is a write.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const app = createApp();
const HARDWARE = "AABBCCDD-1122-3344-5566-778899AABBCC";
const BOOT_TIME = "2026-09-20T08:00:00.000Z";

interface Fixture {
  householdId: string;
  deviceId: string;
  policySetId: string;
  token: string;
}

async function wipe(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users, households RESTART IDENTITY CASCADE`);
}

async function seed(): Promise<Fixture> {
  const householdId = randomUUID();
  const serviceUserId = randomUUID();
  const childId = randomUUID();
  const policySetId = randomUUID();
  const deviceId = randomUUID();

  await db.insert(users).values({
    id: serviceUserId,
    name: "Device service account",
    email: `service+${householdId}@hpc.local`,
    isService: true,
  });
  await db.insert(households).values({ id: householdId, name: "Test", serviceUserId });
  await db.insert(children).values({ id: childId, householdId, displayName: "Lucy" });
  await db.insert(policySets).values({ id: policySetId, householdId, childId });
  await db.insert(scheduleWindows).values({
    householdId,
    policySetId,
    label: "School nights",
    days: ["sun", "mon", "tue", "wed", "thu"],
    restrictedFrom: "21:30",
    restrictedUntil: "07:00",
  });
  await db.insert(devices).values({
    id: deviceId,
    householdId,
    childId,
    policySetId,
    label: "Lucy's Mac mini",
    status: "enrolled",
    hardwareUuid: HARDWARE,
  });

  const credential = await mintDeviceKey({
    serviceUserId,
    deviceId,
    householdId,
    label: "Lucy's Mac mini",
  });
  await db.update(devices).set({ apiKeyId: credential.keyId }).where(eq(devices.id, deviceId));
  await publishPolicy({ deviceId, reason: "enrol" });

  return { householdId, deviceId, policySetId, token: credential.token };
}

/** A well-formed, unremarkable tick. Individual tests perturb one field. */
function tick(deviceId: string, over: Partial<SyncRequest> = {}): SyncRequest {
  return {
    contract: CONTRACT_MINOR,
    device: {
      device_id: deviceId,
      boot_id: randomUUID(),
      hardware_uuid: HARDWARE,
      agent_version: "1.4.2",
      os_version: "26.1",
      arch: "arm64",
      system_boot_time: BOOT_TIME,
    },
    agent: {
      started_at: BOOT_TIME,
      uptime_s: 3600,
      tick_seq: 42,
      clean_exit_previous_run: false,
      previous_stop_reason: null,
      kill_switch: null,
      enforcer_health_age_s: 3,
      capabilities: ["policy.v1", "policy.signature.ed25519", "policy.overrides"],
    },
    clock: {
      local_utc: new Date().toISOString(),
      system_timezone: "America/New_York",
      policy_timezone: "America/New_York",
      using_network_time: true,
      continuous_ns: 1,
      skew_estimate_ms: 0,
      stepped_since_last_sync: false,
    },
    policy_state: { etag: null, policy_version: null },
    enforcement: { state: "idle" },
    queue: { depth: 0, bytes: 0 },
    converged: [],
    ...over,
  };
}

async function sync(token: string, body: unknown): Promise<Response> {
  return app.request("/api/agent/v1/sync", {
    method: "POST",
    headers: { "x-api-key": token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tripwireKinds(deviceId: string): Promise<string[]> {
  const rows = await db
    .select({ kind: tripwires.kind })
    .from(tripwires)
    .where(eq(tripwires.deviceId, deviceId));
  return rows.map((r) => r.kind).sort();
}

beforeEach(async () => {
  if (hasDb) await wipe();
});
afterAll(async () => {
  if (hasDb) {
    await wipe();
    await closeDb();
  }
});

d("POST /sync — the tick", () => {
  it("flips enrolled -> active and writes the six observational columns", async () => {
    const f = await seed();
    const res = await sync(f.token, tick(f.deviceId));
    expect(res.status).toBe(200);

    const [device] = await db.select().from(devices).where(eq(devices.id, f.deviceId));
    expect(device?.status).toBe("active");
    expect(device?.lastSyncAt).not.toBeNull();
    expect(device?.lastTickSeq).toBe(42);
    expect(device?.lastBootId).not.toBeNull();
    expect(device?.agentVersion).toBe("1.4.2");
    expect(device?.osVersion).toBe("26.1");
    expect(device?.arch).toBe("arm64");
  });

  /** ⚠️ Health belongs to step 5's liveness job. One writer per column. */
  it("does NOT touch health_state", async () => {
    const f = await seed();
    await sync(f.token, tick(f.deviceId));
    const [device] = await db.select().from(devices).where(eq(devices.id, f.deviceId));
    expect(device?.healthState).toBe("UNENROLLED");
    expect(device?.healthSince).toBeNull();
  });

  it("echoes the contract minor and a server time", async () => {
    const f = await seed();
    const body = (await (await sync(f.token, tick(f.deviceId))).json()) as Record<string, unknown>;
    expect(body.contract).toBe(CONTRACT_MINOR);
    expect(typeof body.server_time).toBe("string");
    expect(body.device_status).toBe("active");
  });

  it("rejects a body whose device_id is not the credential's — §5.9", async () => {
    const f = await seed();
    const res = await sync(f.token, tick(randomUUID()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hpc_action).toBe("halt_sync_keep_enforcing");
  });

  it("rejects a malformed body with 400 / drop_batch", async () => {
    const f = await seed();
    const res = await sync(f.token, { nonsense: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).hpc_action).toBe("drop_batch");
  });

  it("401s without a credential, and keeps enforcing — X1b", async () => {
    await seed();
    const res = await app.request("/api/agent/v1/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).hpc_action).toBe(
      "halt_sync_keep_enforcing",
    );
  });
});

d("POST /sync — the policy envelope", () => {
  it("sends the full policy when the agent has no etag", async () => {
    const f = await seed();
    const body = (await (await sync(f.token, tick(f.deviceId))).json()) as {
      policy: Record<string, unknown>;
    };
    expect(body.policy.unchanged).toBe(false);
    expect(body.policy.policy_version).toBe(1);
    expect(body.policy.jws ?? body.policy.document).toBeTruthy();
  });

  it("says unchanged when the etag matches, and sends no payload", async () => {
    const f = await seed();
    const [current] = await db
      .select({ etag: policyVersions.etag })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));

    const body = (await (
      await sync(f.token, tick(f.deviceId, { policy_state: { etag: current?.etag } }))
    ).json()) as { policy: Record<string, unknown> };

    expect(body.policy.unchanged).toBe(true);
    expect(body.policy.etag).toBe(current?.etag);
    expect(body.policy.jws).toBeUndefined();
    expect(body.policy.document).toBeUndefined();
  });

  it("sends the full policy again when the agent's etag is stale", async () => {
    const f = await seed();
    const body = (await (
      await sync(f.token, tick(f.deviceId, { policy_state: { etag: 'W/"pol-deadbeef0000-v0"' } }))
    ).json()) as { policy: Record<string, unknown> };
    expect(body.policy.unchanged).toBe(false);
  });

  it("omits `policy` entirely when nothing is compiled", async () => {
    const f = await seed();
    await db.delete(policyVersions).where(eq(policyVersions.deviceId, f.deviceId));
    const body = (await (await sync(f.token, tick(f.deviceId))).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("policy");
  });
});

d("POST /sync — tripwires", () => {
  it("raises nothing for an unremarkable tick", async () => {
    const f = await seed();
    await sync(f.token, tick(f.deviceId));
    expect(await tripwireKinds(f.deviceId)).toEqual([]);
  });

  it("hardware_uuid_mismatch", async () => {
    const f = await seed();
    const t = tick(f.deviceId);
    t.device.hardware_uuid = "SWAPPED-LOGIC-BOARD";
    await sync(f.token, t);
    expect(await tripwireKinds(f.deviceId)).toContain("hardware_uuid_mismatch");
  });

  it("network_time_disabled", async () => {
    const f = await seed();
    const t = tick(f.deviceId);
    t.clock.using_network_time = false;
    await sync(f.token, t);
    expect(await tripwireKinds(f.deviceId)).toContain("network_time_disabled");
  });

  it("timezone_mismatch", async () => {
    const f = await seed();
    const t = tick(f.deviceId);
    t.clock.system_timezone = "Asia/Taipei";
    await sync(f.token, t);
    expect(await tripwireKinds(f.deviceId)).toContain("timezone_mismatch");
  });

  it("signature_invalid", async () => {
    const f = await seed();
    const t = tick(f.deviceId);
    t.policy_state = { etag: null, policy_version: null, signature_valid: false, using_lkg: true };
    await sync(f.token, t);
    expect(await tripwireKinds(f.deviceId)).toContain("signature_invalid");
  });

  it("kill_switch_present", async () => {
    const f = await seed();
    const t = tick(f.deviceId);
    t.agent.kill_switch = { until: "2026-09-20T23:00:00Z" };
    await sync(f.token, t);
    expect(await tripwireKinds(f.deviceId)).toContain("kill_switch_present");
  });

  it("policy_version_regression", async () => {
    const f = await seed();
    await sync(f.token, tick(f.deviceId, { policy_state: { etag: null, policy_version: 5 } }));
    await sync(f.token, tick(f.deviceId, { policy_state: { etag: null, policy_version: 3 } }));
    expect(await tripwireKinds(f.deviceId)).toContain("policy_version_regression");
  });

  it("agent_stopped_while_up — §7.4's strongest tell", async () => {
    const f = await seed();
    await sync(f.token, tick(f.deviceId)); // records system_boot_time
    const t = tick(f.deviceId);
    t.agent.clean_exit_previous_run = true;
    t.agent.previous_stop_reason = "signal";
    await sync(f.token, t); // clean exit, same boot time -> someone stopped it
    expect(await tripwireKinds(f.deviceId)).toContain("agent_stopped_while_up");
  });

  it("a clean exit AFTER a reboot is not a tripwire", async () => {
    const f = await seed();
    await sync(f.token, tick(f.deviceId));
    const t = tick(f.deviceId);
    t.agent.clean_exit_previous_run = true;
    t.device.system_boot_time = "2026-09-21T08:00:00.000Z"; // rebooted
    await sync(f.token, t);
    expect(await tripwireKinds(f.deviceId)).not.toContain("agent_stopped_while_up");
  });

  it("bumps occurrences rather than adding rows — one banner, never eight", async () => {
    const f = await seed();
    const t = tick(f.deviceId);
    t.clock.using_network_time = false;
    await sync(f.token, t);
    await sync(f.token, t);
    await sync(f.token, t);

    const rows = await db
      .select({ occurrences: tripwires.occurrences })
      .from(tripwires)
      .where(and(eq(tripwires.deviceId, f.deviceId), eq(tripwires.kind, "network_time_disabled")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(3);
  });
});

d("POST /sync — desired state", () => {
  async function addDesired(f: Fixture, kind: string, spec: unknown): Promise<string> {
    const [row] = await db
      .insert(desiredItems)
      .values({ householdId: f.householdId, deviceId: f.deviceId, kind, spec })
      .returning({ id: desiredItems.id });
    return (row as { id: string }).id;
  }

  it("ships pending items", async () => {
    const f = await seed();
    await addDesired(f, "agent_version", { version: "1.5.0" });
    const body = (await (await sync(f.token, tick(f.deviceId))).json()) as {
      desired: { kind: string }[];
    };
    expect(body.desired).toHaveLength(1);
    expect(body.desired[0]?.kind).toBe("agent_version");
  });

  /** R6 over R4 — an item the device cannot do must come back `unsupported`. */
  it("ships an item even when the device did not advertise that kind", async () => {
    const f = await seed();
    await addDesired(f, "agent_version", { version: "1.5.0" });
    // The default tick advertises no `desired.*` capability at all.
    const body = (await (await sync(f.token, tick(f.deviceId))).json()) as { desired: unknown[] };
    expect(body.desired).toHaveLength(1);
  });

  it("records `unsupported` from converged[] and stops re-sending", async () => {
    const f = await seed();
    const id = await addDesired(f, "self_test", {});

    await sync(
      f.token,
      tick(f.deviceId, {
        converged: [{ desired_id: id, status: "unsupported", detail: "no such capability" }],
      }),
    );

    const [row] = await db.select().from(desiredItems).where(eq(desiredItems.id, id));
    expect(row?.status).toBe("unsupported");
    expect(row?.unsupportedDetail).toBe("no such capability");
    expect(row?.observedAt).not.toBeNull();

    const body = (await (await sync(f.token, tick(f.deviceId))).json()) as { desired: unknown[] };
    expect(body.desired, "unsupported is terminal").toHaveLength(0);
  });

  it("ignores a bare `converged` claim — the server observes for itself", async () => {
    const f = await seed();
    const id = await addDesired(f, "self_test", {});
    await sync(f.token, tick(f.deviceId, { converged: [{ desired_id: id, status: "converged" }] }));
    const [row] = await db.select().from(desiredItems).where(eq(desiredItems.id, id));
    expect(row?.status).toBe("pending");
  });

  it("converges agent_version on the server's OWN observation", async () => {
    const f = await seed();
    const id = await addDesired(f, "agent_version", { version: "1.4.2" }); // already running it
    await sync(f.token, tick(f.deviceId)); // reports agent_version 1.4.2
    const [row] = await db.select().from(desiredItems).where(eq(desiredItems.id, id));
    expect(row?.status).toBe("converged");
  });

  it("does not converge agent_version when the version differs", async () => {
    const f = await seed();
    const id = await addDesired(f, "agent_version", { version: "9.9.9" });
    await sync(f.token, tick(f.deviceId));
    const [row] = await db.select().from(desiredItems).where(eq(desiredItems.id, id));
    expect(row?.status).toBe("pending");
  });
});

d("POST /sync — cadence and capabilities", () => {
  const pollOf = async (f: Fixture, t: SyncRequest): Promise<number> =>
    ((await (await sync(f.token, t)).json()) as { next_poll_after_ms: number }).next_poll_after_ms;

  it("base cadence by default", async () => {
    const f = await seed();
    expect(await pollOf(f, tick(f.deviceId))).toBe(60_000);
  });

  it("boundary cadence when a transition is close", async () => {
    const f = await seed();
    const t = tick(f.deviceId);
    t.enforcement.next_boundary_at = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(await pollOf(f, t)).toBe(15_000);
  });

  it("base cadence when the transition is beyond the lead window", async () => {
    const f = await seed();
    const t = tick(f.deviceId);
    t.enforcement.next_boundary_at = new Date(Date.now() + 6 * 3_600_000).toISOString();
    expect(await pollOf(f, t)).toBe(60_000);
  });

  it("attended cadence wins over boundary", async () => {
    const f = await seed();
    await db
      .update(devices)
      .set({ attendedUntil: new Date(Date.now() + 10 * 60_000) })
      .where(eq(devices.id, f.deviceId));

    const t = tick(f.deviceId);
    t.enforcement.next_boundary_at = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(await pollOf(f, t)).toBe(5_000);
  });

  it("an expired attended flag falls back to base", async () => {
    const f = await seed();
    await db
      .update(devices)
      .set({ attendedUntil: new Date(Date.now() - 1000) })
      .where(eq(devices.id, f.deviceId));
    expect(await pollOf(f, tick(f.deviceId))).toBe(60_000);
  });

  it("clamps a policy-set interval outside [1s, 300s]", async () => {
    const f = await seed();
    await db
      .update(policySets)
      .set({ pollBaseIntervalS: 99_999 })
      .where(eq(policySets.id, f.policySetId));
    expect(await pollOf(f, tick(f.deviceId))).toBe(300_000);
  });

  it("negotiates capabilities down to the intersection — R4", async () => {
    const f = await seed();
    const body = (await (await sync(f.token, tick(f.deviceId))).json()) as {
      server_capabilities: string[];
    };
    // The tick advertises policy.v1, policy.signature.ed25519, policy.overrides
    // and nothing else, so `desired.agent_version` must not come back.
    expect(body.server_capabilities).toContain("policy.v1");
    expect(body.server_capabilities).not.toContain("desired.agent_version");
  });
});

/**
 * ★ B2, finally on the endpoint the spec always named. The gate has been
 * passing against a stub since step 2; on the real `/sync` each call does a
 * scope check, seven tripwire comparisons, six writes and a policy read.
 */
d("X2 — B2 against the real /sync", () => {
  it("30 consecutive ticks all return 200", async () => {
    const f = await seed();
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      statuses.push(
        (
          await sync(
            f.token,
            tick(f.deviceId, { agent: { ...tick(f.deviceId).agent, tick_seq: i } }),
          )
        ).status,
      );
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    // 401 = the raw trap; 429 = the same trap after auth-errors classifies it.
    expect(
      statuses.filter((s) => s === 401),
      "401 here IS the X2 trap",
    ).toHaveLength(0);
    expect(
      statuses.filter((s) => s === 429),
      "429 here IS the X2 trap",
    ).toHaveLength(0);
  });
});

d("GET /api/agent/v1/health", () => {
  it("is reachable with no credential", async () => {
    const res = await app.request("/api/agent/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.contract_versions).toEqual([CONTRACT_MINOR]);
    expect(typeof body.server_time).toBe("string");
  });

  it("does not touch any device row — it is SERVER liveness", async () => {
    const f = await seed();
    const before = await db.select().from(devices).where(eq(devices.id, f.deviceId));
    await app.request("/api/agent/v1/health");
    const after = await db.select().from(devices).where(eq(devices.id, f.deviceId));
    expect(after).toEqual(before);
  });
});

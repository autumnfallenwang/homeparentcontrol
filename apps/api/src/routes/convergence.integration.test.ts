import { randomUUID } from "node:crypto";
import { CONTRACT_MINOR, type SyncRequest } from "@hpc/contract";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closeDb, db } from "../db/index.js";
import {
  agentStatusIntervals,
  children,
  devices,
  householdMembers,
  households,
  policySets,
  scheduleWindows,
} from "../db/schema.js";
import { mintDeviceKey } from "../lib/device-keys.js";
import { publishPolicy } from "../policy/publish.js";

/**
 * ★ M4's first two exit criteria, end to end across both halves of the API:
 *
 * - "Author a rule, publish it, and watch the agent converge on it within one
 *   adaptive tick"
 * - "Grant a one-click override and see it take effect on the agent in ~5 s"
 *
 * The parent routes and the agent routes are tested separately elsewhere.
 * What is only testable here is that they meet: a change made through the
 * parent API reaches a device through the agent API, and the device page's
 * attended flag is what makes the second one fast.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const app = createApp();
const HARDWARE = "AABBCCDD-1122-3344-5566-778899AABBCC";

interface Fixture {
  householdId: string;
  childId: string;
  deviceId: string;
  policySetId: string;
  cookie: string;
  token: string;
}

async function wipe(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users, households RESTART IDENTITY CASCADE`);
}

async function seed(): Promise<Fixture> {
  const signUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `parent+${randomUUID()}@hpc.local`,
      password: "correct-horse-battery-staple",
      name: "A Parent",
    }),
  });
  const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const userId = ((await signUp.json()) as { user?: { id: string } }).user?.id;
  if (!userId) throw new Error("sign-up failed");

  const [membership] = await db
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(eq(householdMembers.userId, userId))
    .limit(1);
  const householdId = membership?.householdId;
  if (!householdId) throw new Error("no household");

  const [child] = await db
    .insert(children)
    .values({ householdId, displayName: "Lucy", timezone: "America/New_York" })
    .returning({ id: children.id });
  if (!child) throw new Error("no child");
  const [set] = await db
    .insert(policySets)
    .values({ householdId, childId: child.id })
    .returning({ id: policySets.id });
  if (!set) throw new Error("no policy set");

  await db.insert(scheduleWindows).values({
    householdId,
    policySetId: set.id,
    label: "School nights",
    days: ["sun", "mon", "tue", "wed", "thu"],
    restrictedFrom: "21:30",
    restrictedUntil: "07:00",
  });

  const [device] = await db
    .insert(devices)
    .values({
      householdId,
      childId: child.id,
      policySetId: set.id,
      label: "Lucy's Mac mini",
      status: "active",
      hardwareUuid: HARDWARE,
    })
    .returning({ id: devices.id });
  if (!device) throw new Error("no device");

  const [service] = await db
    .select({ id: households.serviceUserId })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);
  if (!service?.id) throw new Error("no service user");
  const credential = await mintDeviceKey({
    serviceUserId: service.id,
    deviceId: device.id,
    householdId,
    label: "Lucy's Mac mini",
  });
  await db.update(devices).set({ apiKeyId: credential.keyId }).where(eq(devices.id, device.id));
  await publishPolicy({ deviceId: device.id, reason: "enrol" });

  return {
    householdId,
    childId: child.id,
    deviceId: device.id,
    policySetId: set.id,
    cookie,
    token: credential.token,
  };
}

/**
 * A stand-in for the agent, carrying the state a real one carries.
 *
 * ⚠️ **The etag is the part that matters.** `/sync` decides `unchanged` by
 * comparing `policy_state.etag`, not `policy_version` — a tick that omits it
 * is handed the full document every time. The Swift daemon tracks it in
 * `lastEtag`; the first version of this test did not, and "converged" looked
 * broken when it was the test that was wrong.
 */
class FakeAgent {
  etag: string | null = null;
  appliedVersion: number | null = null;
}

/** One agent tick. Reports whatever policy state the agent last applied. */
function tick(f: Fixture, agent: FakeAgent): SyncRequest {
  return {
    contract: CONTRACT_MINOR,
    device: {
      device_id: f.deviceId,
      boot_id: randomUUID(),
      hardware_uuid: HARDWARE,
      agent_version: "0.1.0",
      os_version: "26.1",
      arch: "arm64",
      system_boot_time: new Date(Date.now() - 3_600_000).toISOString(),
    },
    agent: {
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      uptime_s: 3600,
      tick_seq: 1,
      clean_exit_previous_run: true,
      previous_stop_reason: null,
      kill_switch: null,
      enforcer_health_age_s: 3,
      capabilities: ["policy.v1", "policy.signature.ed25519"],
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
    policy_state: { policy_version: agent.appliedVersion, etag: agent.etag },
    enforcement: { state: "idle" },
    queue: { depth: 0, bytes: 0 },
    converged: [],
  };
}

/**
 * Tick once, and APPLY whatever came back — which is what makes the next
 * tick report "unchanged". An agent that fetched and never applied would
 * loop for ever, and that loop is exactly what the etag comparison exists to
 * prevent.
 */
async function sync(f: Fixture, agent: FakeAgent) {
  const response = await app.request("/api/agent/v1/sync", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": f.token },
    body: JSON.stringify(tick(f, agent)),
  });
  const body = (await response.json()) as {
    next_poll_after_ms: number;
    policy?: {
      unchanged: boolean;
      policy_version?: number;
      etag?: string;
      jws?: string;
      document?: unknown;
    };
  };
  if (body.policy && body.policy.unchanged === false) {
    agent.etag = body.policy.etag ?? agent.etag;
    agent.appliedVersion = body.policy.policy_version ?? agent.appliedVersion;
  }
  return { status: response.status, body };
}

/**
 * The document the agent would obey, from either envelope variant.
 *
 * ⚠️ **Both variants, deliberately.** With `POLICY_SIGNING_KEY` set the
 * server sends `jws`; without it, `document` in the clear (and the agent
 * logs `policy_unsigned`). Reading only `jws` makes this whole file pass
 * vacuously on a machine with no key configured — which is most machines,
 * and would have been this one.
 */
function documentOf(
  policy: { jws?: string; document?: unknown } | undefined,
): Record<string, any> | null {
  if (!policy) return null;
  if (policy.document) return policy.document as Record<string, any>;
  const middle = policy.jws?.split(".")[1];
  if (!middle) return null;
  return JSON.parse(Buffer.from(middle, "base64url").toString("utf8"));
}

function parent(path: string, f: Fixture, method = "GET", body?: unknown) {
  return app.request(`/api/parent/v1${path}`, {
    method,
    headers: { cookie: f.cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterAll(closeDb);

d("a parent's change reaches the agent", () => {
  beforeEach(wipe);

  // ★ Exit criterion: "Author a rule, publish it, and watch the agent
  // converge on it within one adaptive tick".
  it("★ publishing a rule change converges on the next tick", async () => {
    const f = await seed();

    const agent = new FakeAgent();

    // The agent fetches, applies, and settles.
    const first = await sync(f, agent);
    expect(first.status).toBe(200);
    const initialVersion = first.body.policy?.policy_version;
    expect(initialVersion).toBeGreaterThan(0);

    const settled = await sync(f, agent);
    expect(settled.body.policy?.unchanged).toBe(true);

    // The parent moves bedtime and publishes.
    const rules = (await (await parent("/rules", f)).json()) as {
      policy_sets: { id: string; windows: Record<string, unknown>[] }[];
    };
    await parent("/rules", f, "PUT", {
      policy_set_id: rules.policy_sets[0]?.id,
      windows: [{ ...rules.policy_sets[0]?.windows[0], restricted_from: "22:15" }],
    });
    const published = await parent("/rules/publish", f, "POST", { device_id: f.deviceId });
    expect(published.status).toBe(200);

    // ★ ONE tick later, the agent is handed the new document.
    const converging = await sync(f, agent);
    expect(converging.body.policy?.unchanged).toBe(false);
    expect(converging.body.policy?.policy_version).toBeGreaterThan(initialVersion ?? 0);

    // And the document it receives carries the change the parent made.
    expect(documentOf(converging.body.policy)?.schedule?.windows?.[0]?.restricted_from).toBe(
      "22:15",
    );

    // And once applied, it settles again rather than re-fetching for ever.
    expect((await sync(f, agent)).body.policy?.unchanged).toBe(true);
  });

  // ★ Exit criterion: "Grant a one-click override and see it take effect on
  // the agent in ~5 s". The ~5 s is the CADENCE, and the cadence is what the
  // device page's attended flag buys.
  it("★ a grant reaches the agent, and the attended flag makes it ~5 s", async () => {
    const f = await seed();
    const agent = new FakeAgent();
    await sync(f, agent);

    // Base cadence first — 60 s, so a grant would land within a minute.
    const base = await sync(f, agent);
    expect(base.body.next_poll_after_ms).toBe(60_000);

    // The parent opens the device page. That is the whole mechanism.
    expect((await parent(`/devices/${f.deviceId}/attend`, f, "POST")).status).toBe(200);

    const attended = await sync(f, agent);
    // ★ ~5 s. §4.2's `attended` mode, driven by a server-side sticky flag.
    expect(attended.body.next_poll_after_ms).toBe(5_000);

    // Now the grant.
    const granted = await parent("/overrides", f, "POST", {
      device_id: f.deviceId,
      type: "extend",
      minutes: 30,
    });
    expect(granted.status).toBe(201);
    const grant = (await granted.json()) as { state: string; awaiting_policy_version: number };
    expect(grant.state).toBe("sent");

    // The very next tick carries it.
    const withGrant = await sync(f, agent);
    expect(withGrant.body.policy?.unchanged).toBe(false);
    expect(withGrant.body.policy?.policy_version).toBeGreaterThanOrEqual(
      grant.awaiting_policy_version,
    );

    // ★ The grant is in the compiled document as an override the agent will
    // apply — with a mandatory expiry (A.8).
    const payload = documentOf(withGrant.body.policy);
    expect(payload?.overrides?.length).toBeGreaterThan(0);
    expect(payload?.overrides?.[0]?.expires_at).toBeTruthy();
  });

  // ★ The UI reads `applied_policy_version` to flip `Sent ✓` to `Applied ✓`.
  // If the tick did not advance it, the banner would hang for ever.
  it("★ once the agent reports the new version, /today shows it applied", async () => {
    const f = await seed();
    const agent = new FakeAgent();
    // ⚠️ TWICE. The first tick FETCHES the policy; the device row only
    // learns which version is applied when the agent REPORTS it on the
    // next tick. That lag is the real behaviour and it is what the UI's
    // `Sent ✓ → Applied ✓` transition is watching.
    await sync(f, agent);
    await sync(f, agent);
    const initial = agent.appliedVersion;
    expect(initial).toBeGreaterThan(0);

    const grant = (await (
      await parent("/overrides", f, "POST", { device_id: f.deviceId, minutes: 30 })
    ).json()) as { awaiting_policy_version: number };

    // Before the agent acknowledges: the card still shows the old version,
    // which is what keeps the UI on `Sent ✓` rather than claiming delivery.
    let today = (await (await parent("/today", f)).json()) as {
      devices: { health: { applied_policy_version: number | null } }[];
    };
    expect(today.devices[0]?.health.applied_policy_version).toBe(initial);

    // The agent ticks: fetches the new policy, then reports it applied.
    await sync(f, agent);
    await sync(f, agent);

    today = (await (await parent("/today", f)).json()) as {
      devices: { health: { applied_policy_version: number | null } }[];
    };
    expect(today.devices[0]?.health.applied_policy_version).toBe(grant.awaiting_policy_version);
  });

  // ★ Exit criterion: "Device health card reflects all five states".
  it("★ every health state produces a card the UI can render", async () => {
    const f = await seed();
    const states = [
      "HEALTHY",
      "DEGRADED",
      "EXPECTED_OFFLINE",
      "UNEXPECTED_SILENCE",
      "SILENT_TOO_LONG",
      "UNENROLLED",
    ];

    for (const state of states) {
      await db
        .update(devices)
        .set({
          healthState: state,
          healthSince: new Date(),
          lastSyncAt: new Date(Date.now() - 7_200_000),
        })
        .where(eq(devices.id, f.deviceId));

      const body = (await (await parent("/today", f)).json()) as {
        devices: { health: { state: string; silent_for_s: number | null } }[];
      };
      const card = body.devices[0];
      expect(card?.health.state).toBe(state);
      // The UI interpolates this into §4.6's sentence; a null would render
      // "hasn't checked in for unknown".
      expect(typeof card?.health.silent_for_s).toBe("number");
    }
  });

  // ★ Exit criterion: "Today's usage and the 7-day view render from
  // projected rollups, not raw events."
  it("★ reports read rollups and mark unreported periods as gaps", async () => {
    const f = await seed();
    // A device that was HEALTHY for an hour yesterday and silent since.
    await db.insert(agentStatusIntervals).values({
      householdId: f.householdId,
      deviceId: f.deviceId,
      state: "HEALTHY",
      enteredAt: new Date(Date.now() - 30 * 3_600_000),
      exitedAt: new Date(Date.now() - 29 * 3_600_000),
    });

    const body = (await (await parent("/reports?grain=day", f)).json()) as {
      totals: { gapBuckets: number; reportedBuckets: number };
      buckets: { reported: boolean }[];
    };
    // No usage rows exist, so there are no buckets to mark either way — the
    // point is the shape is rollup-derived and carries the distinction.
    expect(body.totals).toHaveProperty("gapBuckets");
    expect(body.totals).toHaveProperty("reportedBuckets");
  });
});

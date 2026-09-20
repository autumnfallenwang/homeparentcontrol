import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closeDb, db } from "../db/index.js";
import {
  apikeys,
  children,
  devices,
  householdMembers,
  households,
  overrides,
  policySets,
  policyVersions,
  scheduleWindows,
  tripwires,
  users,
} from "../db/schema.js";
import { mintDeviceKey } from "../lib/device-keys.js";
import { publishPolicy } from "../policy/publish.js";

/**
 * The parent API. Every test here is a trap from §5.8 or §5.5, not a happy
 * path — the happy paths are the easy half.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const app = createApp();

interface Fixture {
  householdId: string;
  userId: string;
  childId: string;
  deviceId: string;
  policySetId: string;
  cookie: string;
}

async function wipe(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users, households RESTART IDENTITY CASCADE`);
}

/**
 * ⚠️ Signs in through better-auth rather than forging a session row — the
 * whole point of these tests is the authenticated path, and a hand-written
 * session would skip exactly the middleware under test.
 */
async function signIn(email: string): Promise<{ userId: string; cookie: string }> {
  const password = "correct-horse-battery-staple";
  const signUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: "A Parent" }),
  });
  const cookie = signUp.headers.get("set-cookie") ?? "";
  const body = (await signUp.json()) as { user?: { id: string } };
  const userId = body.user?.id;
  if (!userId) throw new Error(`sign-up failed: ${JSON.stringify(body)}`);
  return { userId, cookie: cookie.split(";")[0] ?? "" };
}

async function seed(): Promise<Fixture> {
  const { userId, cookie } = await signIn(`parent+${randomUUID()}@hpc.local`);

  // `bootstrap.ts` claims the first household for the first user, so one
  // already exists by the time sign-up returns.
  const [membership] = await db
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(eq(householdMembers.userId, userId))
    .limit(1);
  const householdId = membership?.householdId;
  if (!householdId) throw new Error("bootstrap did not create a household");

  const [child] = await db
    .insert(children)
    .values({ householdId, displayName: "Lucy", timezone: "America/New_York" })
    .returning({ id: children.id });
  const childId = child?.id;
  if (!childId) throw new Error("no child");

  const [set] = await db
    .insert(policySets)
    .values({ householdId, childId })
    .returning({ id: policySets.id });
  const policySetId = set?.id;
  if (!policySetId) throw new Error("no policy set");

  await db.insert(scheduleWindows).values({
    householdId,
    policySetId,
    label: "School nights",
    days: ["sun", "mon", "tue", "wed", "thu"],
    restrictedFrom: "21:30",
    restrictedUntil: "07:00",
  });

  const [device] = await db
    .insert(devices)
    .values({
      householdId,
      childId,
      policySetId,
      label: "Lucy's Mac mini",
      status: "active",
      hardwareUuid: `HW-${randomUUID()}`,
    })
    .returning({ id: devices.id });
  const deviceId = device?.id;
  if (!deviceId) throw new Error("no device");

  const [serviceUser] = await db
    .select({ id: households.serviceUserId })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);
  if (serviceUser?.id) {
    const credential = await mintDeviceKey({
      serviceUserId: serviceUser.id,
      deviceId,
      householdId,
      label: "Lucy's Mac mini",
    });
    await db.update(devices).set({ apiKeyId: credential.keyId }).where(eq(devices.id, deviceId));
  }

  await publishPolicy({ deviceId, reason: "enrol" });
  return { householdId, userId, childId, deviceId, policySetId, cookie };
}

function get(path: string, f: Fixture) {
  return app.request(`/api/parent/v1${path}`, { headers: { cookie: f.cookie } });
}
function send(path: string, f: Fixture, method: string, body?: unknown) {
  return app.request(`/api/parent/v1${path}`, {
    method,
    headers: { cookie: f.cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterAll(closeDb);

d("parent API — authentication and scope", () => {
  beforeEach(wipe);

  it("refuses an unauthenticated caller", async () => {
    const response = await app.request("/api/parent/v1/today");
    expect(response.status).toBe(401);
  });

  // ★ One household exists today, which is exactly why this must be
  // structural: the bug is unreachable until the moment it is catastrophic.
  it("★ a parent cannot reach another household's device", async () => {
    const mine = await seed();
    // A second household, with its own device.
    const otherHouseholdId = randomUUID();
    const otherServiceId = randomUUID();
    await db.insert(users).values({
      id: otherServiceId,
      name: "Other service",
      email: `service+${otherHouseholdId}@hpc.local`,
      isService: true,
    });
    await db
      .insert(households)
      .values({ id: otherHouseholdId, name: "Other", serviceUserId: otherServiceId });
    const [otherChild] = await db
      .insert(children)
      .values({ householdId: otherHouseholdId, displayName: "Sam" })
      .returning({ id: children.id });
    if (!otherChild) throw new Error("no other child");
    const [otherSet] = await db
      .insert(policySets)
      .values({ householdId: otherHouseholdId, childId: otherChild.id })
      .returning({ id: policySets.id });
    if (!otherSet) throw new Error("no other policy set");
    const [otherDevice] = await db
      .insert(devices)
      .values({
        householdId: otherHouseholdId,
        childId: otherChild.id,
        policySetId: otherSet.id,
        label: "Sam's Mac",
        status: "active",
      })
      .returning({ id: devices.id });

    const response = await get(`/devices/${otherDevice?.id}`, mine);
    expect(response.status).toBe(404);

    // And `today` shows only ours.
    const today = (await (await get("/today", mine)).json()) as {
      devices: { device_id: string }[];
    };
    expect(today.devices.map((row) => row.device_id)).toEqual([mine.deviceId]);
  });
});

d("GET /today", () => {
  beforeEach(wipe);

  it("returns one card per device with health and tonight's boundary", async () => {
    const f = await seed();
    const body = (await (await get("/today", f)).json()) as {
      devices: {
        device_id: string;
        health: { state: string };
        tonight: { windows: { restricted_from: string }[] } | null;
        usage_today: { active_s: number };
      }[];
    };
    expect(body.devices).toHaveLength(1);
    const card = body.devices[0];
    expect(card?.device_id).toBe(f.deviceId);
    expect(card?.health.state).toBeTruthy();
    // ★ Read out of the COMPILED document, not recomputed from the rows.
    expect(card?.tonight?.windows[0]?.restricted_from).toBe("21:30");
    expect(card?.usage_today.active_s).toBe(0);
  });

  // ★ §5.8: "one tripwire banner not eight".
  it("★ shows ONE banner and a count, never a list", async () => {
    const f = await seed();
    for (const kind of ["timezone_mismatch", "unexpected_source_ip", "kill_switch_present"]) {
      await db.insert(tripwires).values({ householdId: f.householdId, deviceId: f.deviceId, kind });
    }

    const body = (await (await get("/today", f)).json()) as {
      devices: { banner: { kind: string; severity: string; also_open: number } | null }[];
    };
    const banner = body.devices[0]?.banner;
    // The loudest wins; the rest are a number.
    expect(banner?.kind).toBe("kill_switch_present");
    expect(banner?.severity).toBe("alarm");
    expect(banner?.also_open).toBe(2);
  });

  it("an acknowledged tripwire stops being a banner", async () => {
    const f = await seed();
    await db.insert(tripwires).values({
      householdId: f.householdId,
      deviceId: f.deviceId,
      kind: "timezone_mismatch",
      acknowledgedAt: new Date(),
    });
    const body = (await (await get("/today", f)).json()) as {
      devices: { banner: unknown | null }[];
    };
    expect(body.devices[0]?.banner).toBeNull();
  });

  // ⚠️ The home page must NOT put every device into 5-second polling.
  it("★ /today does not set attended_until", async () => {
    const f = await seed();
    await get("/today", f);
    const [row] = await db
      .select({ attendedUntil: devices.attendedUntil })
      .from(devices)
      .where(eq(devices.id, f.deviceId));
    expect(row?.attendedUntil).toBeNull();
  });
});

d("the attended flag", () => {
  beforeEach(wipe);

  // ★ The whole mechanism behind the 5-second grant.
  it("★ POST /devices/:id/attend sets a 10-minute window", async () => {
    const f = await seed();
    const before = Date.now();
    const response = await send(`/devices/${f.deviceId}/attend`, f, "POST");
    expect(response.status).toBe(200);

    const [row] = await db
      .select({ attendedUntil: devices.attendedUntil })
      .from(devices)
      .where(eq(devices.id, f.deviceId));
    const until = row?.attendedUntil?.getTime() ?? 0;
    expect(until).toBeGreaterThanOrEqual(before + 9 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 11 * 60_000);
  });

  // ★ A prefetch of the device page must be inert.
  it("★ GET /devices/:id does NOT set it", async () => {
    const f = await seed();
    await get(`/devices/${f.deviceId}`, f);
    const [row] = await db
      .select({ attendedUntil: devices.attendedUntil })
      .from(devices)
      .where(eq(devices.id, f.deviceId));
    expect(row?.attendedUntil).toBeNull();
  });
});

d("POST /overrides", () => {
  beforeEach(wipe);

  // ★ "Applied" is the agent's word, not the server's.
  it("★ reports `sent`, never `applied`", async () => {
    const f = await seed();
    const response = await send("/overrides", f, "POST", {
      device_id: f.deviceId,
      type: "extend",
      minutes: 30,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { state: string; expires_at: string };
    expect(body.state).toBe("sent");
    expect(body.state).not.toBe("applied");
  });

  // ★ A.8 — mandatory, and computed here so a client cannot choose it.
  it("★ expires_at is server-computed and in the future", async () => {
    const f = await seed();
    const body = (await (
      await send("/overrides", f, "POST", { device_id: f.deviceId, minutes: 30 })
    ).json()) as { expires_at: string };
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());

    const [row] = await db
      .select({ expiresAt: overrides.expiresAt })
      .from(overrides)
      .where(eq(overrides.deviceId, f.deviceId));
    expect(row?.expiresAt).toBeTruthy();
  });

  it("★ a client-supplied expiry is ignored", async () => {
    const f = await seed();
    const faraway = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const body = (await (
      await send("/overrides", f, "POST", {
        device_id: f.deviceId,
        minutes: 30,
        expires_at: faraway,
      })
    ).json()) as { expires_at: string };
    // A stale policy can only ever converge stricter, and that depends on
    // grants dying on their own schedule.
    expect(body.expires_at).not.toBe(faraway);
    expect(new Date(body.expires_at).getTime()).toBeLessThan(Date.now() + 2 * 86_400_000);
  });

  it("publishing a grant produces a new policy version", async () => {
    const f = await seed();
    const before = await db
      .select({ version: policyVersions.version })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));
    await send("/overrides", f, "POST", { device_id: f.deviceId, minutes: 30 });
    const after = await db
      .select({ version: policyVersions.version })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));
    expect(after.length).toBeGreaterThan(before.length);
  });

  // §4.3: caps are enforced at write time AND in the agent, "so a server
  // that would happily issue a 6-hour grant cannot produce a UI that lies".
  it("★ the daily grant cap is enforced server-side", async () => {
    const f = await seed();
    await db
      .update(policySets)
      .set({ overrideMaxGrantsPerDay: 1 })
      .where(eq(policySets.id, f.policySetId));

    expect(
      (await send("/overrides", f, "POST", { device_id: f.deviceId, minutes: 15 })).status,
    ).toBe(201);
    const second = await send("/overrides", f, "POST", { device_id: f.deviceId, minutes: 15 });
    expect(second.status).toBe(422);
  });

  it("★ the daily minute cap is enforced server-side", async () => {
    const f = await seed();
    await db
      .update(policySets)
      .set({ overrideMaxMinutesPerDay: 30 })
      .where(eq(policySets.id, f.policySetId));

    await send("/overrides", f, "POST", { device_id: f.deviceId, minutes: 30 });
    const second = await send("/overrides", f, "POST", { device_id: f.deviceId, minutes: 30 });
    expect(second.status).toBe(422);
  });

  it("a suspend grant needs no minutes and still carries an expiry", async () => {
    const f = await seed();
    const body = (await (
      await send("/overrides", f, "POST", { device_id: f.deviceId, type: "suspend" })
    ).json()) as { expires_at: string; state: string };
    expect(body.state).toBe("sent");
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("revoking an override keeps the row for the audit trail", async () => {
    const f = await seed();
    const created = (await (
      await send("/overrides", f, "POST", { device_id: f.deviceId, minutes: 30 })
    ).json()) as { override_id: string };

    expect((await send(`/overrides/${created.override_id}`, f, "DELETE")).status).toBe(200);
    const [row] = await db
      .select({ revokedAt: overrides.revokedAt })
      .from(overrides)
      .where(eq(overrides.id, created.override_id));
    expect(row?.revokedAt).toBeTruthy();
  });

  it("a decommissioned device cannot be granted anything", async () => {
    const f = await seed();
    await db.update(devices).set({ status: "decommissioned" }).where(eq(devices.id, f.deviceId));
    const response = await send("/overrides", f, "POST", { device_id: f.deviceId, minutes: 30 });
    expect(response.status).toBe(409);
  });
});

d("Revoke vs Decommission (§5.5)", () => {
  beforeEach(wipe);

  // ★ "the UI must make these typed-confirmation actions" — and a
  // confirmation only the browser checks is one anyone can skip with curl.
  it("★ both require the typed word, checked on the SERVER", async () => {
    const f = await seed();
    expect((await send(`/devices/${f.deviceId}/revoke`, f, "POST", {})).status).toBe(422);
    expect(
      (await send(`/devices/${f.deviceId}/revoke`, f, "POST", { confirm: "yes" })).status,
    ).toBe(422);
    expect(
      (await send(`/devices/${f.deviceId}/decommission`, f, "POST", { confirm: "REVOKE" })).status,
    ).toBe(422);
  });

  // ★ They look alike and behave oppositely.
  it("★ revoke kills the credential and says enforcement CONTINUES", async () => {
    const f = await seed();
    const response = await send(`/devices/${f.deviceId}/revoke`, f, "POST", { confirm: "REVOKE" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stops_enforcement: boolean; status: string };
    expect(body.stops_enforcement).toBe(false);
    expect(body.status).toBe("revoked");

    const [device] = await db
      .select({ apiKeyId: devices.apiKeyId })
      .from(devices)
      .where(eq(devices.id, f.deviceId));
    const [key] = await db
      .select({ enabled: apikeys.enabled })
      .from(apikeys)
      .where(eq(apikeys.id, device?.apiKeyId ?? ""));
    expect(key?.enabled).toBe(false);
  });

  it("★ decommission says enforcement STOPS, and keeps the telemetry", async () => {
    const f = await seed();
    const response = await send(`/devices/${f.deviceId}/decommission`, f, "POST", {
      confirm: "DECOMMISSION",
    });
    const body = (await response.json()) as { stops_enforcement: boolean };
    expect(body.stops_enforcement).toBe(true);

    // "the child's history is not the device's property" — the policy
    // versions, and every projected row, survive.
    const versions = await db
      .select({ version: policyVersions.version })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));
    expect(versions.length).toBeGreaterThan(0);
  });
});

d("rules: diff, publish, restore", () => {
  beforeEach(wipe);

  it("the diff returns the COMPILED documents, not the rows", async () => {
    const f = await seed();
    const body = (await (await get(`/rules/diff?device_id=${f.deviceId}`, f)).json()) as {
      proposed_document: { schedule?: { windows?: unknown[] } };
      current_version: number | null;
    };
    // A compiled document has a schedule with resolved windows on it.
    expect(body.proposed_document.schedule?.windows).toBeDefined();
    expect(body.current_version).toBeGreaterThan(0);
  });

  // ★ C3 — "Firing the guard on every +30-minute grant trains the parent to
  // click through it in exactly the case it was built for."
  it("★ an unchanged schedule does not ask for confirmation", async () => {
    const f = await seed();
    const body = (await (await get(`/rules/diff?device_id=${f.deviceId}`, f)).json()) as {
      confirm_immediate_effect: boolean;
    };
    expect(body.confirm_immediate_effect).toBe(false);
  });

  it("★ a RELAXATION never asks for confirmation, however large", async () => {
    const f = await seed();
    const rules = (await (await get("/rules", f)).json()) as {
      policy_sets: { id: string; windows: Record<string, unknown>[] }[];
    };
    const set = rules.policy_sets[0];
    const window = { ...set?.windows[0], restricted_from: "23:59" };
    await send("/rules", f, "PUT", { policy_set_id: set?.id, windows: [window] });

    const body = (await (await get(`/rules/diff?device_id=${f.deviceId}`, f)).json()) as {
      confirm_immediate_effect: boolean;
      changed: boolean;
    };
    expect(body.changed).toBe(true);
    expect(body.confirm_immediate_effect).toBe(false);
  });

  /**
   * ★ The falsification. Every other C3 test asserts the guard stays SILENT,
   * and a detector that never fires would pass all of them. This is the one
   * that proves it can fire, and the pair together are what make the silence
   * meaningful.
   */
  it("★ a TIGHTENING inside 15 minutes DOES ask for confirmation", async () => {
    const f = await seed();
    const rules = (await (await get("/rules", f)).json()) as {
      policy_sets: { id: string; windows: Record<string, unknown>[] }[];
    };
    const set = rules.policy_sets[0];

    // Five minutes from now, in the CHILD's timezone — the same zone the
    // compiled document carries, because the detector compares against that.
    const soon = new Date(Date.now() + 5 * 60_000);
    const hhmm = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(soon);

    await send("/rules", f, "PUT", {
      policy_set_id: set?.id,
      windows: [
        {
          ...set?.windows[0],
          // Every day, so "tonight" is always today.
          days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
          restricted_from: hhmm,
        },
      ],
    });

    const body = (await (await get(`/rules/diff?device_id=${f.deviceId}`, f)).json()) as {
      confirm_immediate_effect: boolean;
      confirm_reason: string | null;
    };
    expect(body.confirm_immediate_effect).toBe(true);
    expect(body.confirm_reason).toContain("minutes");
  });

  // ★ And the guard is re-checked at PUBLISH time, not only at diff time —
  // a tab left open for an hour turns a 40-minute-away change into a
  // 4-minute-away one.
  it("★ publishing an unconfirmed tightening is refused", async () => {
    const f = await seed();
    const rules = (await (await get("/rules", f)).json()) as {
      policy_sets: { id: string; windows: Record<string, unknown>[] }[];
    };
    const soon = new Date(Date.now() + 5 * 60_000);
    const hhmm = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(soon);
    await send("/rules", f, "PUT", {
      policy_set_id: rules.policy_sets[0]?.id,
      windows: [
        {
          ...rules.policy_sets[0]?.windows[0],
          days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
          restricted_from: hhmm,
        },
      ],
    });

    const refused = await send("/rules/publish", f, "POST", { device_id: f.deviceId });
    expect(refused.status).toBe(409);

    const accepted = await send("/rules/publish", f, "POST", {
      device_id: f.deviceId,
      confirmed_immediate_effect: true,
    });
    expect(accepted.status).toBe(200);
  });

  // ★ Restore is `git revert`, not `git reset`.
  it("★ restore publishes a NEW version and never mutates history", async () => {
    const f = await seed();
    const before = await db
      .select({ version: policyVersions.version, hash: policyVersions.documentHash })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));
    const firstVersion = before[0]?.version ?? 1;

    // Change the rules and publish.
    const rules = (await (await get("/rules", f)).json()) as {
      policy_sets: { id: string; windows: Record<string, unknown>[] }[];
    };
    const set = rules.policy_sets[0];
    await send("/rules", f, "PUT", {
      policy_set_id: set?.id,
      windows: [{ ...set?.windows[0], restricted_from: "20:00" }],
    });
    await send("/rules/publish", f, "POST", { device_id: f.deviceId });

    // Restore the original.
    const response = await send(
      `/rules/history/${firstVersion}/restore?device_id=${f.deviceId}`,
      f,
      "POST",
    );
    expect(response.status).toBe(200);

    const after = await db
      .select({ version: policyVersions.version })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));

    // Strictly more versions, and the original is still there untouched.
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.map((row) => row.version)).toContain(firstVersion);
    // The newest version is the highest number — never a rewind, which
    // would fire the agent's `policy_version_regression` tripwire on a
    // legitimate parent action.
    const highest = Math.max(...after.map((row) => row.version));
    expect(highest).toBeGreaterThan(firstVersion);
  });

  it("saving rules does not publish them", async () => {
    const f = await seed();
    const before = await db
      .select({ version: policyVersions.version })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));

    const rules = (await (await get("/rules", f)).json()) as {
      policy_sets: { id: string; windows: Record<string, unknown>[] }[];
    };
    await send("/rules", f, "PUT", {
      policy_set_id: rules.policy_sets[0]?.id,
      windows: [{ ...rules.policy_sets[0]?.windows[0], restricted_from: "22:15" }],
    });

    const after = await db
      .select({ version: policyVersions.version })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));
    expect(after.length).toBe(before.length);
  });

  it("a zero-length window is refused rather than silently enforcing nothing", async () => {
    const f = await seed();
    const rules = (await (await get("/rules", f)).json()) as {
      policy_sets: { id: string; windows: Record<string, unknown>[] }[];
    };
    const response = await send("/rules", f, "PUT", {
      policy_set_id: rules.policy_sets[0]?.id,
      windows: [
        {
          ...rules.policy_sets[0]?.windows[0],
          restricted_from: "21:00",
          restricted_until: "21:00",
        },
      ],
    });
    expect(response.status).toBe(422);
  });

  // ⚠️ A.34 made structural: the action vocabulary is the boundary.
  it("★ an action outside {lock, shutdown} is rejected", async () => {
    const f = await seed();
    const rules = (await (await get("/rules", f)).json()) as {
      policy_sets: { id: string; windows: Record<string, unknown>[] }[];
    };
    const response = await send("/rules", f, "PUT", {
      policy_set_id: rules.policy_sets[0]?.id,
      windows: [{ ...rules.policy_sets[0]?.windows[0], action: "disable_remote_login" }],
    });
    expect(response.status).toBe(400);
  });
});

d("GET /setup", () => {
  beforeEach(wipe);

  // ★ A code a parent can look up later is a code waiting to enrol
  // something else.
  it("★ an enrolment code is shown once and never returned again", async () => {
    const f = await seed();
    const created = (await (
      await send("/devices", f, "POST", { child_id: f.childId, label: "Spare Mac" })
    ).json()) as { device_id: string; code: string };
    expect(created.code).toMatch(/^HPC(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);

    const setup = (await (await get("/setup", f)).json()) as {
      pending_codes: { device_id: string; hint: string }[];
    };
    const pending = setup.pending_codes.find((row) => row.device_id === created.device_id);
    expect(pending).toBeDefined();
    // The hint identifies it; the code itself is gone.
    expect(JSON.stringify(setup)).not.toContain(created.code);
    expect(created.code.startsWith(pending?.hint ?? "@@@")).toBe(true);
  });

  it("★ a live device cannot be handed a fresh code", async () => {
    const f = await seed();
    const response = await send(`/devices/${f.deviceId}/enrolment-code`, f, "POST");
    expect(response.status).toBe(409);
  });

  it("reports what still needs doing", async () => {
    const f = await seed();
    const body = (await (await get("/setup", f)).json()) as { next_step: string };
    expect(["done", "enrol_device"]).toContain(body.next_step);
  });
});

d("GET /reports", () => {
  beforeEach(wipe);

  it("returns rollup buckets, not raw events", async () => {
    const f = await seed();
    const body = (await (await get("/reports?grain=day", f)).json()) as {
      buckets: unknown[];
      totals: { activeS: number; gapBuckets: number };
      labels: { children: unknown[] };
    };
    expect(Array.isArray(body.buckets)).toBe(true);
    expect(body.totals).toBeDefined();
    expect(body.labels.children).toHaveLength(1);
  });

  it("refuses a range too wide to materialise", async () => {
    const f = await seed();
    const from = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const response = await get(
      `/reports?grain=hour&from=${from}&to=${new Date().toISOString()}`,
      f,
    );
    expect(response.status).toBe(422);
  });

  it("refuses a backwards range", async () => {
    const f = await seed();
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 86_400_000).toISOString();
    expect((await get(`/reports?from=${now}&to=${earlier}`, f)).status).toBe(422);
  });
});

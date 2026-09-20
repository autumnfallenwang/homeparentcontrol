import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closeDb, db } from "../db/index.js";
import {
  apikeys,
  children,
  devices,
  households,
  policySets,
  scheduleWindows,
  users,
} from "../db/schema.js";
import { mintDeviceKey } from "../lib/device-keys.js";
import { publishPolicy } from "../policy/publish.js";
import { closeExpiredRotations, OVERLAP_MS } from "./credential.js";

/**
 * `POST /credential/rotate`, and the 24 h overlap.
 *
 * The property under test throughout: **a device is never left without a
 * working credential.** Everything else here is bookkeeping.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const app = createApp();
const HARDWARE = "AABBCCDD-1122-3344-5566-778899AABBCC";

interface Fixture {
  householdId: string;
  deviceId: string;
  token: string;
  keyId: string;
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
    status: "active",
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

  return { householdId, deviceId, token: credential.token, keyId: credential.keyId };
}

async function rotate(token: string): Promise<Response> {
  return app.request("/api/agent/v1/credential/rotate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({ desired_id: randomUUID() }),
  });
}

// ⚠️ ONE `afterAll(closeDb)` for the file, not one per `describe`. Two
// suites each closing the pool means the first one to finish tears down the
// connection the second is still using, and the failure surfaces as
// `CONNECTION_ENDED` inside an unrelated test.
afterAll(closeDb);

d("POST /credential/rotate", () => {
  beforeEach(wipe);

  it("issues a new credential and points the device at it", async () => {
    const fixture = await seed();
    const response = await rotate(fixture.token);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      credential: { token: string; key_id: string; rotate_after: string };
      previous_credential_valid_until: string;
    };
    expect(body.credential.token).toMatch(/^hpc_dk_/);
    expect(body.credential.key_id).not.toBe(fixture.keyId);

    const [device] = await db
      .select({ apiKeyId: devices.apiKeyId, previousApiKeyId: devices.previousApiKeyId })
      .from(devices)
      .where(eq(devices.id, fixture.deviceId));
    expect(device?.apiKeyId).toBe(body.credential.key_id);
    expect(device?.previousApiKeyId).toBe(fixture.keyId);
  });

  // ★ The whole point of the overlap.
  it("★ the OLD credential still works immediately after rotation", async () => {
    const fixture = await seed();
    await rotate(fixture.token);

    const response = await app.request("/api/agent/v1/whoami", {
      headers: { "x-api-key": fixture.token },
    });
    expect(response.status).toBe(200);
  });

  it("★ the NEW credential works too", async () => {
    const fixture = await seed();
    const body = (await (await rotate(fixture.token)).json()) as {
      credential: { token: string };
    };

    const response = await app.request("/api/agent/v1/whoami", {
      headers: { "x-api-key": body.credential.token },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { device_id: string }).device_id).toBe(fixture.deviceId);
  });

  it("gives the old key a 24 h expiry rather than disabling it", async () => {
    const fixture = await seed();
    const before = Date.now();
    await rotate(fixture.token);

    const [old] = await db
      .select({ enabled: apikeys.enabled, expiresAt: apikeys.expiresAt })
      .from(apikeys)
      .where(eq(apikeys.id, fixture.keyId));
    expect(old?.enabled).toBe(true);
    const expiry = old?.expiresAt?.getTime() ?? 0;
    expect(expiry).toBeGreaterThanOrEqual(before + OVERLAP_MS - 5_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + OVERLAP_MS + 5_000);
  });

  // ★ X2 again, at the one other place a key is minted.
  it("★ the rotated key has rate limiting OFF", async () => {
    const fixture = await seed();
    const body = (await (await rotate(fixture.token)).json()) as {
      credential: { key_id: string };
    };

    const [key] = await db
      .select({ rateLimitEnabled: apikeys.rateLimitEnabled })
      .from(apikeys)
      .where(eq(apikeys.id, body.credential.key_id));
    // A rotated key that throttles at 10 req/24h would halt sync about ten
    // minutes later and report its credential revoked — X2, reached through
    // a door that did not exist when the trap was first closed.
    expect(key?.rateLimitEnabled).toBe(false);
  });

  it("the rotated key keeps the device's scopes", async () => {
    const fixture = await seed();
    const body = (await (await rotate(fixture.token)).json()) as {
      credential: { key_id: string };
    };

    const [key] = await db
      .select({ permissions: apikeys.permissions })
      .from(apikeys)
      .where(eq(apikeys.id, body.credential.key_id));
    expect(key?.permissions).toContain("sync");
    expect(key?.permissions).toContain("events:write");
  });

  // ★ Each rotation remembers exactly ONE predecessor.
  it("★ a second rotation inside the window is refused, not silently orphaning a key", async () => {
    const fixture = await seed();
    const body = (await (await rotate(fixture.token)).json()) as {
      credential: { token: string };
    };

    const second = await rotate(body.credential.token);
    expect(second.status).toBe(409);
    const problem = (await second.json()) as { hpc_action: string };
    // `backoff`, not a terminal error: the desired item is re-sent next tick
    // and succeeds once the window closes.
    expect(problem.hpc_action).toBe("backoff");

    // And the first old key is still the one being tracked, so it will
    // actually get disabled.
    const [device] = await db
      .select({ previousApiKeyId: devices.previousApiKeyId })
      .from(devices)
      .where(eq(devices.id, fixture.deviceId));
    expect(device?.previousApiKeyId).toBe(fixture.keyId);
  });

  it("rotation is refused without a credential", async () => {
    await seed();
    const response = await app.request("/api/agent/v1/credential/rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  // ★ X1b — nothing here may switch enforcement off.
  it("★ rotation never touches the device's policy or health", async () => {
    const fixture = await seed();
    const [before] = await db
      .select({
        healthState: devices.healthState,
        appliedPolicyVersion: devices.appliedPolicyVersion,
        lastSyncAt: devices.lastSyncAt,
      })
      .from(devices)
      .where(eq(devices.id, fixture.deviceId));

    await rotate(fixture.token);

    const [after] = await db
      .select({
        healthState: devices.healthState,
        appliedPolicyVersion: devices.appliedPolicyVersion,
        lastSyncAt: devices.lastSyncAt,
      })
      .from(devices)
      .where(eq(devices.id, fixture.deviceId));
    expect(after).toEqual(before);
  });

  // ⚠️ A.27's converse, the same rule `/policy` and `/events` follow.
  it("rotation is not a heartbeat", async () => {
    const fixture = await seed();
    await rotate(fixture.token);
    const [device] = await db
      .select({ lastSyncAt: devices.lastSyncAt })
      .from(devices)
      .where(eq(devices.id, fixture.deviceId));
    expect(device?.lastSyncAt).toBeNull();
  });
});

d("closeExpiredRotations", () => {
  beforeEach(wipe);

  it("leaves an overlap that has not expired alone", async () => {
    const fixture = await seed();
    await rotate(fixture.token);

    expect(await closeExpiredRotations()).toBe(0);
    const [old] = await db
      .select({ enabled: apikeys.enabled })
      .from(apikeys)
      .where(eq(apikeys.id, fixture.keyId));
    expect(old?.enabled).toBe(true);
  });

  it("disables the superseded key once the window has passed", async () => {
    const fixture = await seed();
    await rotate(fixture.token);

    // 24 h and a minute later.
    const closed = await closeExpiredRotations(new Date(Date.now() + OVERLAP_MS + 60_000));
    expect(closed).toBe(1);

    const [old] = await db
      .select({ enabled: apikeys.enabled })
      .from(apikeys)
      .where(eq(apikeys.id, fixture.keyId));
    expect(old?.enabled).toBe(false);

    const [device] = await db
      .select({ previousApiKeyId: devices.previousApiKeyId })
      .from(devices)
      .where(eq(devices.id, fixture.deviceId));
    expect(device?.previousApiKeyId).toBeNull();
  });

  // ★ Once the pointer is cleared, rotating again must work.
  it("★ a device can rotate again once its previous window has closed", async () => {
    const fixture = await seed();
    const first = (await (await rotate(fixture.token)).json()) as {
      credential: { token: string };
    };
    await closeExpiredRotations(new Date(Date.now() + OVERLAP_MS + 60_000));

    const second = await rotate(first.credential.token);
    expect(second.status).toBe(200);
  });

  it("is idempotent — a second run closes nothing", async () => {
    const fixture = await seed();
    await rotate(fixture.token);
    const at = new Date(Date.now() + OVERLAP_MS + 60_000);
    expect(await closeExpiredRotations(at)).toBe(1);
    expect(await closeExpiredRotations(at)).toBe(0);
  });
});

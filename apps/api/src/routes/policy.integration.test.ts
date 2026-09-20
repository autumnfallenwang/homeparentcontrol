import { createPublicKey, randomUUID, verify } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { auth } from "../auth.js";
import { closeDb, db } from "../db/index.js";
import {
  apikeys,
  children,
  devices,
  households,
  policySets,
  policyVersions,
  scheduleWindows,
  users,
} from "../db/schema.js";
import { mintDeviceKey } from "../lib/device-keys.js";
import { publishPolicy } from "../policy/publish.js";
import { getSigningKey } from "../policy/signing.js";

/**
 * `GET /api/agent/v1/policy` — the conditional GET, the scope check, and the
 * rule the spec never states: this endpoint must not look like liveness.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const app = createApp();

interface Fixture {
  deviceId: string;
  token: string;
  keyId: string;
}

async function wipe(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users, households RESTART IDENTITY CASCADE`);
}

async function seedEnrolledDevice(label = "Lucy's Mac mini"): Promise<Fixture> {
  const householdId = randomUUID();
  const serviceUserId = randomUUID();
  const childId = randomUUID();
  const policySetId = randomUUID();
  const deviceId = randomUUID();

  const [existing] = await db
    .select({ id: households.id, serviceUserId: households.serviceUserId })
    .from(households)
    .limit(1);

  let owningHousehold = existing?.id;
  let owningService = existing?.serviceUserId ?? undefined;
  if (!owningHousehold) {
    await db.insert(users).values({
      id: serviceUserId,
      name: "Device service account",
      email: `service+${householdId}@hpc.local`,
      isService: true,
    });
    await db.insert(households).values({ id: householdId, name: "Test", serviceUserId });
    owningHousehold = householdId;
    owningService = serviceUserId;
  }

  await db
    .insert(children)
    .values({ id: childId, householdId: owningHousehold, displayName: "Lucy" });
  await db.insert(policySets).values({ id: policySetId, householdId: owningHousehold, childId });
  await db.insert(scheduleWindows).values({
    householdId: owningHousehold,
    policySetId,
    label: "School nights",
    days: ["sun", "mon", "tue", "wed", "thu"],
    restrictedFrom: "21:30",
    restrictedUntil: "07:00",
  });
  await db.insert(devices).values({
    id: deviceId,
    householdId: owningHousehold,
    childId,
    policySetId,
    label,
  });

  const credential = await mintDeviceKey({
    serviceUserId: owningService as string,
    deviceId,
    householdId: owningHousehold,
    label,
  });
  await db.update(devices).set({ apiKeyId: credential.keyId }).where(eq(devices.id, deviceId));
  await publishPolicy({ deviceId, reason: "enrol" });

  return { deviceId, token: credential.token, keyId: credential.keyId };
}

const get = (token?: string, headers: Record<string, string> = {}) =>
  app.request("/api/agent/v1/policy", {
    headers: token ? { "x-api-key": token, ...headers } : headers,
  });

beforeEach(async () => {
  if (hasDb) await wipe();
});
afterAll(async () => {
  if (hasDb) {
    await wipe();
    await closeDb();
  }
});

d("GET /policy", () => {
  it("returns the current policy with an ETag and no-cache", async () => {
    const f = await seedEnrolledDevice();
    const res = await get(f.token);

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\/"pol-[0-9a-f]{12}-v1"$/);
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.unchanged).toBe(false);
    expect(body.policy_version).toBe(1);
  });

  it("returns 304 for a matching If-None-Match, with no body", async () => {
    const f = await seedEnrolledDevice();
    const etag = (await get(f.token)).headers.get("etag") as string;

    const res = await get(f.token, { "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("returns the full policy when the ETag does not match", async () => {
    const f = await seedEnrolledDevice();
    const res = await get(f.token, { "if-none-match": 'W/"pol-000000000000-v0"' });
    expect(res.status).toBe(200);
  });

  it("serves a verifiable JWS when signing is on", async () => {
    const key = getSigningKey();
    if (!key) return; // unsigned run; covered by the unsigned case below

    const f = await seedEnrolledDevice();
    const body = (await (await get(f.token)).json()) as { jws?: string };
    expect(body.jws).toBeTruthy();

    const [header, payload, sig] = (body.jws as string).split(".");
    const pub = createPublicKey({ key: key.publicJwk as never, format: "jwk" });
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        pub,
        Buffer.from(sig as string, "base64url"),
      ),
    ).toBe(true);
  });

  it("serves the bare document when running unsigned", async () => {
    if (getSigningKey()) return; // signed run
    const f = await seedEnrolledDevice();
    const body = (await (await get(f.token)).json()) as Record<string, unknown>;
    expect(body.document).toBeTruthy();
    expect(body.jws).toBeUndefined();
  });

  it("404s with no hpc_action when nothing is compiled", async () => {
    const f = await seedEnrolledDevice();
    await db.delete(policyVersions).where(eq(policyVersions.deviceId, f.deviceId));

    const res = await get(f.token);
    expect(res.status).toBe(404);
    // 404 is absent from §4.7's table, so no agent behaviour is defined for it.
    expect(await res.json()).not.toHaveProperty("hpc_action");
  });
});

d("GET /policy — auth and scope", () => {
  it("401s with no credential", async () => {
    await seedEnrolledDevice();
    expect((await get()).status).toBe(401);
  });

  it("401s on a bogus credential, not a 500", async () => {
    await seedEnrolledDevice();
    expect((await get("hpc_dk_not-real")).status).toBe(401);
  });

  it("carries halt_sync_keep_enforcing on 401 — X1b, revocation is not a bypass", async () => {
    await seedEnrolledDevice();
    const body = (await (await get("hpc_dk_not-real")).json()) as Record<string, unknown>;
    expect(body.hpc_action).toBe("halt_sync_keep_enforcing");
  });

  it("a key bound to no device is a scope violation, not a 200", async () => {
    // §5.9 — scope is the actual security control here, not the transport.
    const f = await seedEnrolledDevice();
    await db.update(devices).set({ apiKeyId: null }).where(eq(devices.id, f.deviceId));
    const res = await get(f.token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hpc_action).toBe("halt_sync_keep_enforcing");
  });

  it("one device cannot read another device's policy", async () => {
    const a = await seedEnrolledDevice("Mac A");
    const b = await seedEnrolledDevice("Mac B");

    const bodyA = (await (await get(a.token)).json()) as { policy_version: number };
    const etagB = (await get(b.token)).headers.get("etag");
    const etagA = (await get(a.token)).headers.get("etag");

    expect(bodyA.policy_version).toBe(1);
    // Different devices, different documents — device_id is inside the hash.
    expect(etagA).not.toBe(etagB);
  });

  /**
   * ✅ B4, closed 2026-09-20. better-auth 1.4.19 accepts the §5.9 permissions
   * shape, round-trips it, and enforces it. So device keys carry one scope per
   * endpoint rather than full authority, and the resolver checks them.
   */
  it("refuses a key that lacks the endpoint's scope", async () => {
    const f = await seedEnrolledDevice();
    await db
      .update(apikeys)
      .set({ permissions: JSON.stringify({ device: ["sync", "events:write"] }) })
      .where(eq(apikeys.id, f.keyId));

    const res = await get(f.token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.detail)).toContain("policy:read");
  });

  it("accepts a key that carries it", async () => {
    const f = await seedEnrolledDevice();
    expect((await get(f.token)).status).toBe(200);
  });

  it("mints keys with all three scopes and nothing more", async () => {
    const f = await seedEnrolledDevice();
    const [row] = await db
      .select({ permissions: apikeys.permissions })
      .from(apikeys)
      .where(eq(apikeys.id, f.keyId));
    expect(JSON.parse(row?.permissions as string)).toEqual({
      device: ["sync", "policy:read", "events:write"],
    });
  });

  /**
   * ⚠️ MEASURED, not documented. better-auth 1.4.19 reuses the API key's id as
   * the synthesised session's id, which is how `requireDevice` resolves the
   * caller in one lookup. If a future version changes it, this fails here
   * rather than silently serving the wrong device's policy.
   */
  it("the API-key session id IS the key id", async () => {
    const f = await seedEnrolledDevice();
    const session = await auth.api.getSession({
      headers: new Headers({ "x-api-key": f.token }),
    });
    expect(session?.session.id).toBe(f.keyId);
  });
});

/**
 * ★ The rule the spec never states.
 *
 * §4.5 says operators poll this endpoint "with curl constantly", and A.26 says
 * the tick is the heartbeat. If a read here counted as liveness, an operator
 * curling a dead device's policy would keep it looking HEALTHY — the precise
 * failure the health design exists to prevent.
 */
d("GET /policy is not a heartbeat", () => {
  it("never touches last_sync_at, health_state or the device row at all", async () => {
    const f = await seedEnrolledDevice();
    const before = await db.select().from(devices).where(eq(devices.id, f.deviceId));

    await get(f.token);
    await get(f.token, { "if-none-match": 'W/"pol-000000000000-v0"' });
    const etag = (await get(f.token)).headers.get("etag") as string;
    await get(f.token, { "if-none-match": etag }); // a 304 too

    const after = await db.select().from(devices).where(eq(devices.id, f.deviceId));
    expect(after[0]?.lastSyncAt).toBeNull();
    expect(after[0]?.healthState).toBe("UNENROLLED");
    expect(after).toEqual(before);
  });
});

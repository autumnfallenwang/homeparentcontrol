import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { closeDb, db } from "./db/index.js";
import { apikeys, children, devices, householdMembers, households, users } from "./db/schema.js";
import { assertNoRateLimitedDeviceKeys } from "./lib/assert-x2.js";
import { claimFirstHousehold } from "./lib/bootstrap.js";
import { mintDeviceKey } from "./lib/device-keys.js";

/**
 * Auth, the first-run claim, and the X2 carve-out, against real Postgres.
 *
 * Self-skips without DATABASE_URL so `test:fast` and CI stay DB-free.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const app = createApp();

const PASSWORD = "correct-horse-battery-staple";

/**
 * A device row for the key to hang off. `/whoami` resolves the caller through
 * `devices.api_key_id` (§5.9 — scope is the security control), so a key bound
 * to nothing is a 403 by design.
 */
async function deviceFor(householdId: string): Promise<string> {
  const childId = randomUUID();
  const deviceId = randomUUID();
  await db.insert(children).values({ id: childId, householdId, displayName: "Lucy" });
  await db.insert(devices).values({ id: deviceId, householdId, childId, label: "Lucy's Mac mini" });
  return deviceId;
}

/** The household the first sign-up claimed, with its service user resolved. */
async function claimedHousehold(): Promise<{ id: string; serviceUserId: string }> {
  const [h] = await db
    .select({ id: households.id, serviceUserId: households.serviceUserId })
    .from(households);
  if (!h?.serviceUserId) throw new Error("the first-run claim did not run");
  return { id: h.id, serviceUserId: h.serviceUserId };
}

async function signUp(email: string, name: string): Promise<Response> {
  return app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
}

/**
 * ⚠️ Wipes the database. TRUNCATE users CASCADE reaches every table, because
 * households -> children -> devices all hang off it. That is intended: the
 * first-run claim only fires at count(users) === 0, so without a clean slate
 * the first run of this suite would poison every later one. Dev DB only.
 */
async function wipe(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
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

d("first-run claim (§5.5)", () => {
  it("claims a household, a service user and an owner membership on first sign-up", async () => {
    const res = await signUp("parent@hpc.local", "Parent");
    expect(res.status).toBe(200);

    const rows = await db
      .select({
        householdName: households.name,
        serviceUserId: households.serviceUserId,
        isService: users.isService,
        memberRole: householdMembers.role,
      })
      .from(households)
      .innerJoin(users, eq(users.id, households.serviceUserId))
      .innerJoin(householdMembers, eq(householdMembers.householdId, households.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.householdName).toBe("Parent's household");
    expect(rows[0]?.isService, "A.21 — keys must hang off a service user").toBe(true);
    expect(rows[0]?.memberRole).toBe("owner");
  });

  it("makes the first human an admin and the service user an ordinary one", async () => {
    await signUp("parent@hpc.local", "Parent");
    const all = await db
      .select({ email: users.email, role: users.role, isService: users.isService })
      .from(users);

    expect(all).toHaveLength(2); // the human + the service account
    const human = all.find((u) => !u.isService);
    const service = all.find((u) => u.isService);
    expect(human?.role).toBe("admin");
    expect(service?.role).toBe("user");
  });

  it("is idempotent — a second call creates nothing", async () => {
    await signUp("parent@hpc.local", "Parent");
    expect(await claimFirstHousehold()).toBeNull();
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(households);
    expect(rows[0]?.n).toBe(1);
  });

  it("no-ops when no human has signed up", async () => {
    expect(await claimFirstHousehold()).toBeNull();
  });
});

d("signup gate (§5.5 — 'after that, signup is closed')", () => {
  it("allows the first sign-up and refuses the second", async () => {
    expect((await signUp("first@hpc.local", "First")).status).toBe(200);

    const second = await signUp("second@hpc.local", "Second");
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ error: expect.stringContaining("closed") });

    // and it really did not create the row
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.isService, false));
    expect(rows[0]?.n).toBe(1);
  });
});

d("X2 — the carve-out", () => {
  async function enrolledKey(): Promise<{ token: string; keyId: string }> {
    await signUp("parent@hpc.local", "Parent");
    const h = await claimedHousehold();
    const deviceId = await deviceFor(h.id);
    const key = await mintDeviceKey({
      serviceUserId: h.serviceUserId,
      deviceId,
      householdId: h.id,
      label: "Lucy's Mac mini",
    });
    await db.update(devices).set({ apiKeyId: key.keyId }).where(eq(devices.id, deviceId));
    return key;
  }

  it("PLACE 2 — a minted device key has rate_limit_enabled = false", async () => {
    const { keyId } = await enrolledKey();
    const [row] = await db
      .select({ rateLimitEnabled: apikeys.rateLimitEnabled, prefix: apikeys.prefix })
      .from(apikeys)
      .where(eq(apikeys.id, keyId));
    expect(row?.rateLimitEnabled, "the column DEFAULTS to true — the mint must override").toBe(
      false,
    );
  });

  it("PLACE 3 — the boot assertion passes clean, and fires on a throttled row", async () => {
    const { keyId } = await enrolledKey();
    await expect(assertNoRateLimitedDeviceKeys()).resolves.toBeUndefined();

    await db.update(apikeys).set({ rateLimitEnabled: true }).where(eq(apikeys.id, keyId));
    await expect(assertNoRateLimitedDeviceKeys()).rejects.toThrow(/X2 violated/);
  });

  /**
   * ★ B2 — THE GATE. Non-negotiable.
   *
   * better-auth's per-key limiter defaults to 10 requests per 24h. If it ever
   * comes back on, a device stops syncing ~10 minutes after enrolment and
   * keeps enforcing a policy it can never update again.
   *
   * 30 consecutive calls is three times the default quota. Sequential on
   * purpose: the limiter counts requests, and parallel calls could race past
   * the counter and pass by accident.
   *
   * ✅ Falsified 2026-09-20 — this test does not pass vacuously. Turning the
   * limiter back on at places 1 and 2 makes it fail at exactly 10 × 200, which
   * is the documented quota. Both 401 and 429 are checked because the status
   * depends on whether `lib/auth-errors.ts` is in the chain: raw it is 401,
   * classified it is 429. Either means the carve-out is gone.
   */
  it("PLACE 4 (B2) — 30 consecutive authenticated calls all return 200", async () => {
    const { token } = await enrolledKey();

    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await app.request("/api/agent/v1/whoami", {
        headers: { "x-api-key": token },
      });
      statuses.push(res.status);
    }

    expect(statuses).toHaveLength(30);
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(
      statuses.filter((s) => s === 401),
      "a 401 here IS the X2 trap",
    ).toHaveLength(0);
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
  });
});

d("agent credential path", () => {
  it("rejects a missing key with 401", async () => {
    const res = await app.request("/api/agent/v1/whoami");
    expect(res.status).toBe(401);
  });

  it("rejects a bogus key with 401, not a 500", async () => {
    // better-auth throws APIError out of getSession for an unknown key;
    // requireAuth has to catch it or Hono's default handler returns 500.
    const res = await app.request("/api/agent/v1/whoami", {
      headers: { "x-api-key": "hpc_dk_definitely-not-real" },
    });
    expect(res.status).toBe(401);
  });

  it("resolves a real key to the service user", async () => {
    await signUp("parent@hpc.local", "Parent");
    const h = await claimedHousehold();
    const deviceId = await deviceFor(h.id);
    const key = await mintDeviceKey({
      serviceUserId: h.serviceUserId,
      deviceId,
      householdId: h.id,
      label: "Lucy's Mac mini",
    });
    await db.update(devices).set({ apiKeyId: key.keyId }).where(eq(devices.id, deviceId));
    const token = key.token;

    const res = await app.request("/api/agent/v1/whoami", { headers: { "x-api-key": token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user_id: h.serviceUserId, is_service: true });
  });
});

d("A.21 — device keys survive deleting a parent", () => {
  it("deleting the human owner does NOT cascade to the device key", async () => {
    await signUp("parent@hpc.local", "Parent");
    const h = await claimedHousehold();
    const { keyId } = await mintDeviceKey({
      serviceUserId: h.serviceUserId,
      deviceId: await deviceFor(h.id),
      householdId: h.id,
      label: "Lucy's Mac mini",
    });

    // apikeys.userId is NOT NULL ON DELETE CASCADE. If keys hung off the
    // parent, removing a parent would silently revoke every Mac in the house.
    await db.delete(users).where(eq(users.isService, false));

    const [row] = await db.select({ id: apikeys.id }).from(apikeys).where(eq(apikeys.id, keyId));
    expect(row?.id, "the device key must outlive the parent").toBe(keyId);
  });
});

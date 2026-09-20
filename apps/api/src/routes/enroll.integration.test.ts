import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closeDb, db } from "../db/index.js";
import {
  apikeys,
  children,
  devices,
  enrollments,
  households,
  policySets,
  policyVersions,
  scheduleWindows,
  tripwires,
  users,
} from "../db/schema.js";
import {
  enrolmentCodeHint,
  generateEnrolmentCode,
  hashEnrolmentCode,
} from "../lib/enrolment-codes.js";

/**
 * `POST /enroll` against real Postgres — §5.5's transaction and the whole of
 * its six-case interruption table.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const app = createApp();
const HARDWARE = "AABBCCDD-1122-3344-5566-778899AABBCC";

interface Fixture {
  householdId: string;
  deviceId: string;
  code: string;
}

async function wipe(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users, households RESTART IDENTITY CASCADE`);
}

async function seed(opts: { expiresInMinutes?: number } = {}): Promise<Fixture> {
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
  });

  const code = generateEnrolmentCode();
  const minutes = opts.expiresInMinutes ?? 60;
  await db.insert(enrollments).values({
    householdId,
    deviceId,
    codeHash: hashEnrolmentCode(code),
    codeHint: enrolmentCodeHint(code),
    expiresAt: new Date(Date.now() + minutes * 60_000),
  });

  return { householdId, deviceId, code };
}

async function enrol(body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/agent/v1/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

d("POST /enroll — the happy path", () => {
  it("exchanges a code for a credential, a device and policy v1", async () => {
    const f = await seed();
    const res = await enrol({ code: f.code, hardware_uuid: HARDWARE, hostname: "lucys-mac" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      device_id: string;
      credential: { token: string; key_id: string };
      policy_signing_keys: unknown[];
    };
    expect(body.device_id).toBe(f.deviceId);
    expect(body.credential.token).toMatch(/^hpc_dk_/);

    const [device] = await db
      .select({
        status: devices.status,
        hardwareUuid: devices.hardwareUuid,
        hostname: devices.hostname,
        apiKeyId: devices.apiKeyId,
      })
      .from(devices)
      .where(eq(devices.id, f.deviceId));
    expect(device?.status).toBe("enrolled");
    expect(device?.hardwareUuid).toBe(HARDWARE);
    expect(device?.hostname).toBe("lucys-mac");
    expect(device?.apiKeyId).toBe(body.credential.key_id);

    // §5.5 — v1 in the same transaction, "so the very first tick gets a real
    // policy rather than a 404".
    const versions = await db
      .select({ version: policyVersions.version })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
  });

  it("marks the code consumed, with the IP and hardware that used it", async () => {
    const f = await seed();
    await enrol({ code: f.code, hardware_uuid: HARDWARE });
    const [row] = await db.select().from(enrollments).where(eq(enrollments.deviceId, f.deviceId));
    expect(row?.consumedAt).not.toBeNull();
    expect(row?.consumedHardwareUuid).toBe(HARDWARE);
  });

  it("accepts any spelling of the code", async () => {
    const f = await seed();
    const messy = f.code.toLowerCase().replace(/-/g, " ");
    expect((await enrol({ code: messy, hardware_uuid: HARDWARE })).status).toBe(201);
  });

  it("mints a key with rate limiting off — X2 place 2, on the real path", async () => {
    const f = await seed();
    const res = await enrol({ code: f.code, hardware_uuid: HARDWARE });
    const { credential } = (await res.json()) as { credential: { key_id: string } };
    const [key] = await db
      .select({ rateLimitEnabled: apikeys.rateLimitEnabled })
      .from(apikeys)
      .where(eq(apikeys.id, credential.key_id));
    expect(key?.rateLimitEnabled).toBe(false);
  });
});

d("POST /enroll — §5.5's interruption table", () => {
  it("unknown code → 404, never 401", async () => {
    await seed();
    const res = await enrol({ code: generateEnrolmentCode(), hardware_uuid: HARDWARE });
    // §5.4: "A bad code is a 404/400, never a 401 — so it can never be
    // confused with a revoked credential."
    expect(res.status).toBe(404);
  });

  it("expired code → 410", async () => {
    const f = await seed({ expiresInMinutes: -1 });
    expect((await enrol({ code: f.code, hardware_uuid: HARDWARE })).status).toBe(410);
  });

  it("re-issue: same code, same hardware, key never used → 201 and reissue_count++", async () => {
    const f = await seed();
    const first = (await (await enrol({ code: f.code, hardware_uuid: HARDWARE })).json()) as {
      credential: { key_id: string };
    };

    const res = await enrol({ code: f.code, hardware_uuid: HARDWARE });
    expect(res.status).toBe(201);
    const second = (await res.json()) as { credential: { key_id: string } };
    expect(second.credential.key_id).not.toBe(first.credential.key_id);

    const [row] = await db.select().from(enrollments).where(eq(enrollments.deviceId, f.deviceId));
    expect(row?.reissueCount).toBe(1);

    // The unused credential is revoked, not left working.
    const old = await db.select().from(apikeys).where(eq(apikeys.id, first.credential.key_id));
    expect(old).toHaveLength(0);
  });

  it("re-issue refused when the hardware differs → 409", async () => {
    const f = await seed();
    await enrol({ code: f.code, hardware_uuid: HARDWARE });
    const res = await enrol({ code: f.code, hardware_uuid: "DIFFERENT-MAC-UUID" });
    expect(res.status).toBe(409);
  });

  it("re-issue refused once the credential has been used → 409", async () => {
    const f = await seed();
    const { credential } = (await (
      await enrol({ code: f.code, hardware_uuid: HARDWARE })
    ).json()) as { credential: { key_id: string } };

    // Simulate the agent having actually called something with it.
    await db
      .update(apikeys)
      .set({ lastRequest: new Date() })
      .where(eq(apikeys.id, credential.key_id));

    expect((await enrol({ code: f.code, hardware_uuid: HARDWARE })).status).toBe(409);
  });

  it("burns the row after 5 failed attempts", async () => {
    const f = await seed();
    await enrol({ code: f.code, hardware_uuid: HARDWARE }); // consume it
    for (let i = 0; i < 5; i++) {
      await enrol({ code: f.code, hardware_uuid: "WRONG-HARDWARE" });
    }
    const [row] = await db.select().from(enrollments).where(eq(enrollments.deviceId, f.deviceId));
    expect(row?.attempts).toBeGreaterThanOrEqual(5);
  });

  it("an unattempted code leaves the device pending, and the row alive", async () => {
    const f = await seed();
    const [device] = await db
      .select({ status: devices.status })
      .from(devices)
      .where(eq(devices.id, f.deviceId));
    expect(device?.status).toBe("pending");
    const rows = await db.select().from(enrollments).where(eq(enrollments.deviceId, f.deviceId));
    expect(rows).toHaveLength(1); // ⚠️ never auto-deleted
  });

  it("a changed hardware UUID on re-enrol raises a tripwire, it does not refuse", async () => {
    const f = await seed();
    await db
      .update(devices)
      .set({ hardwareUuid: "ORIGINAL-LOGIC-BOARD" })
      .where(eq(devices.id, f.deviceId));

    expect((await enrol({ code: f.code, hardware_uuid: HARDWARE })).status).toBe(201);
    const trip = await db.select().from(tripwires).where(eq(tripwires.deviceId, f.deviceId));
    expect(trip).toHaveLength(1);
    expect(trip[0]?.kind).toBe("hardware_uuid_mismatch");
  });

  it("two Macs racing one code: exactly one 201", async () => {
    // The single-use guarantee is the conditional UPDATE, not a read-then-write.
    const f = await seed();
    const [a, b] = await Promise.all([
      enrol({ code: f.code, hardware_uuid: "MAC-A" }),
      enrol({ code: f.code, hardware_uuid: "MAC-B" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 201 || s === 409)).toHaveLength(2);

    const keys = await db.select().from(apikeys);
    expect(keys, "the loser must not leave an orphaned credential").toHaveLength(1);
  });
});

d("POST /enroll — the wire contract", () => {
  it("is reachable with NO credential", async () => {
    const f = await seed();
    expect((await enrol({ code: f.code, hardware_uuid: HARDWARE })).status).toBe(201);
  });

  it("rejects a body with no hardware_uuid", async () => {
    const f = await seed();
    expect((await enrol({ code: f.code })).status).toBe(400);
  });

  it("rejects a malformed code shape", async () => {
    await seed();
    expect((await enrol({ code: "nope", hardware_uuid: HARDWARE })).status).toBe(400);
  });

  /** ★ The guard: nothing pre-credential may carry an agent action. */
  it("NEVER returns an hpc_action, on any status", async () => {
    const f = await seed();
    const responses = [
      await enrol({ code: generateEnrolmentCode(), hardware_uuid: HARDWARE }), // 404
      await enrol({ code: "nope", hardware_uuid: HARDWARE }), // 400
      await enrol({ code: f.code, hardware_uuid: HARDWARE }), // 201
      await enrol({ code: f.code, hardware_uuid: "OTHER" }), // 409
    ];
    for (const res of responses) {
      const body = (await res.json()) as Record<string, unknown>;
      expect(body, `status ${res.status}`).not.toHaveProperty("hpc_action");
    }
  });

  it("emits problem+json on failure", async () => {
    await seed();
    const res = await enrol({ code: generateEnrolmentCode(), hardware_uuid: HARDWARE });
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toContain("/problems/");
    expect(body.instance).toBe("/api/agent/v1/enroll");
  });
});

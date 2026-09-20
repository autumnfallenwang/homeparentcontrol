import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "../db/index.js";
import {
  calendarExceptions,
  children,
  devices,
  households,
  overrides,
  policySets,
  policyVersions,
  scheduleWarnings,
  scheduleWindows,
  users,
} from "../db/schema.js";
import { gatherCompilerInput } from "./gather.js";
import { publishPolicy } from "./publish.js";
import { getSigningKey } from "./signing.js";
import { PolicyCompileError } from "./types.js";

/**
 * `gather` + `publish` against real Postgres. The pure compiler is covered by
 * the golden suite; what needs a database is the churn-killer, the version
 * sequence and the row-level filters §5.6's pseudocode omits.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const NOW = new Date("2026-09-20T18:00:00.000Z"); // Sunday 14:00 EDT

interface Fixture {
  householdId: string;
  childId: string;
  policySetId: string;
  deviceId: string;
  schoolWindowId: string;
  weekendWindowId: string;
}

/** ⚠️ Wipes the database — dev only. See auth.integration.test.ts. */
async function wipe(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users, households RESTART IDENTITY CASCADE`);
}

async function seed(overrides_: { holidayCountries?: string[] | null } = {}): Promise<Fixture> {
  const householdId = randomUUID();
  const serviceUserId = randomUUID();
  const childId = randomUUID();
  const policySetId = randomUUID();
  const deviceId = randomUUID();
  const schoolWindowId = randomUUID();
  const weekendWindowId = randomUUID();

  await db.insert(users).values({
    id: serviceUserId,
    name: "Device service account",
    email: `service+${householdId}@hpc.local`,
    isService: true,
  });
  await db.insert(households).values({
    id: householdId,
    name: "Test household",
    timezone: "America/New_York",
    serviceUserId,
    holidayCountries:
      overrides_.holidayCountries === undefined ? null : overrides_.holidayCountries,
  });
  await db.insert(children).values({ id: childId, householdId, displayName: "Lucy" });
  await db.insert(policySets).values({ id: policySetId, householdId, childId });
  await db.insert(scheduleWindows).values([
    {
      id: schoolWindowId,
      householdId,
      policySetId,
      label: "School nights",
      days: ["sun", "mon", "tue", "wed", "thu"],
      restrictedFrom: "21:30",
      restrictedUntil: "07:00",
      sortOrder: 0,
    },
    {
      id: weekendWindowId,
      householdId,
      policySetId,
      label: "Weekends",
      days: ["fri", "sat"],
      restrictedFrom: "22:30",
      restrictedUntil: "08:00",
      sortOrder: 1,
    },
  ]);
  await db.insert(scheduleWarnings).values([
    { householdId, windowId: schoolWindowId, leadMinutes: 30, channel: "banner" },
    { householdId, windowId: schoolWindowId, leadMinutes: 5, channel: "modal" },
  ]);
  await db.insert(devices).values({
    id: deviceId,
    householdId,
    childId,
    policySetId,
    label: "Lucy's Mac mini",
  });

  return { householdId, childId, policySetId, deviceId, schoolWindowId, weekendWindowId };
}

async function versionCount(deviceId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(policyVersions)
    .where(eq(policyVersions.deviceId, deviceId));
  return rows[0]?.n ?? 0;
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

d("publishPolicy", () => {
  it("creates v1 on first publish", async () => {
    const f = await seed();
    const result = await publishPolicy({ deviceId: f.deviceId, reason: "enrol", now: NOW });

    expect(result.status).toBe("published");
    expect(result.version).toBe(1);
    expect(result.etag).toMatch(/^W\/"pol-[0-9a-f]{12}-v1"$/);
    expect(await versionCount(f.deviceId)).toBe(1);
  });

  /** ★ Milestone 01's exit criterion, and §5.6's "kills recompile churn". */
  it("emits NOTHING when the content hash is unchanged", async () => {
    const f = await seed();
    const first = await publishPolicy({ deviceId: f.deviceId, reason: "enrol", now: NOW });

    // A later clock, so issued_at/not_before differ. If those were hashed this
    // would publish v2 and the churn-killer would be dead code.
    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await publishPolicy({
      deviceId: f.deviceId,
      reason: "schedule_edit",
      now: later,
    });

    expect(second.status).toBe("unchanged");
    expect(second.version).toBe(1);
    expect(second.etag).toBe(first.etag);
    expect(await versionCount(f.deviceId)).toBe(1);
  });

  it("publishes v2 with a new ETag when the schedule actually changes", async () => {
    const f = await seed();
    const first = await publishPolicy({ deviceId: f.deviceId, reason: "enrol", now: NOW });

    await db
      .update(scheduleWindows)
      .set({ restrictedFrom: "22:00" })
      .where(eq(scheduleWindows.id, f.schoolWindowId));

    const second = await publishPolicy({
      deviceId: f.deviceId,
      reason: "schedule_edit",
      now: NOW,
    });
    expect(second.status).toBe("published");
    expect(second.version).toBe(2);
    expect(second.etag).not.toBe(first.etag);
    expect(await versionCount(f.deviceId)).toBe(2);
  });

  it("signs when a key is configured, and records its kid", async () => {
    const f = await seed();
    await publishPolicy({ deviceId: f.deviceId, reason: "enrol", now: NOW });
    const [row] = await db
      .select({ jws: policyVersions.jws, signingKeyId: policyVersions.signingKeyId })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));

    const key = getSigningKey();
    if (key) {
      // Three base64url segments, and the kid is the key's own thumbprint —
      // which is what `policy_signing_keys[]` hands the agent.
      expect(row?.jws?.split(".")).toHaveLength(3);
      expect(row?.signingKeyId).toBe(key.kid);
    } else {
      // The unsigned path, reachable only via ALLOW_UNSIGNED_POLICY=1.
      expect(row?.jws).toBeNull();
      expect(row?.signingKeyId).toBeNull();
    }
  });

  it("records the publish reason and author", async () => {
    const f = await seed();
    await publishPolicy({ deviceId: f.deviceId, reason: "override", now: NOW });
    const [row] = await db
      .select({ reason: policyVersions.publishReason, by: policyVersions.publishedBy })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, f.deviceId));
    expect(row?.reason).toBe("override");
    expect(row?.by).toBeNull();
  });

  it("compiles one version per device — A.17, authored per child", async () => {
    const f = await seed();
    const secondDeviceId = randomUUID();
    await db.insert(devices).values({
      id: secondDeviceId,
      householdId: f.householdId,
      childId: f.childId,
      policySetId: f.policySetId,
      label: "Lucy's MacBook",
    });

    await publishPolicy({ deviceId: f.deviceId, reason: "enrol", now: NOW });
    await publishPolicy({ deviceId: secondDeviceId, reason: "enrol", now: NOW });

    const rows = await db
      .select({ deviceId: policyVersions.deviceId, hash: policyVersions.documentHash })
      .from(policyVersions);
    expect(rows).toHaveLength(2);
    // Same authoring state, different device_id -> different content hash,
    // because device_id is inside the document.
    expect(rows[0]?.hash).not.toBe(rows[1]?.hash);
  });

  it("throws when the device has no policy set and its child has none", async () => {
    const f = await seed();
    await db.delete(scheduleWindows).where(eq(scheduleWindows.policySetId, f.policySetId));
    await db.update(devices).set({ policySetId: null }).where(eq(devices.id, f.deviceId));
    await db.delete(policySets).where(eq(policySets.id, f.policySetId));

    await expect(
      publishPolicy({ deviceId: f.deviceId, reason: "enrol", now: NOW }),
    ).rejects.toThrow(PolicyCompileError);
  });

  it("falls back to the child's policy set when the device has none", async () => {
    const f = await seed();
    await db.update(devices).set({ policySetId: null }).where(eq(devices.id, f.deviceId));

    const result = await publishPolicy({ deviceId: f.deviceId, reason: "enrol", now: NOW });
    expect(result.status).toBe("published");

    // and it back-fills the device so the next read is one query
    const [device] = await db
      .select({ policySetId: devices.policySetId })
      .from(devices)
      .where(eq(devices.id, f.deviceId));
    expect(device?.policySetId).toBe(f.policySetId);
  });
});

d("gatherCompilerInput — the row filters §5.6 omits", () => {
  it("excludes a revoked grant", async () => {
    const f = await seed();
    await db.insert(overrides).values({
      householdId: f.householdId,
      childId: f.childId,
      type: "extend",
      minutes: 30,
      effectiveDate: "2026-09-20",
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      revokedAt: NOW,
    });
    const input = await gatherCompilerInput(f.deviceId, NOW);
    expect(input.grants).toHaveLength(0);
  });

  it("excludes an expired grant", async () => {
    const f = await seed();
    await db.insert(overrides).values({
      householdId: f.householdId,
      childId: f.childId,
      type: "extend",
      minutes: 30,
      effectiveDate: "2026-09-19",
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const input = await gatherCompilerInput(f.deviceId, NOW);
    expect(input.grants).toHaveLength(0);
  });

  /**
   * ⚠️ The filter §5.6's pseudocode leaves out. Without it a grant scoped to
   * the sibling's Mac is compiled into this one's document — the column exists
   * precisely to prevent that.
   */
  it("excludes a grant scoped to a DIFFERENT device", async () => {
    const f = await seed();
    const otherDeviceId = randomUUID();
    await db.insert(devices).values({
      id: otherDeviceId,
      householdId: f.householdId,
      childId: f.childId,
      policySetId: f.policySetId,
      label: "Sibling's Mac",
    });
    await db.insert(overrides).values({
      householdId: f.householdId,
      childId: f.childId,
      deviceId: otherDeviceId,
      type: "extend",
      minutes: 30,
      effectiveDate: "2026-09-20",
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });

    const mine = await gatherCompilerInput(f.deviceId, NOW);
    expect(mine.grants).toHaveLength(0);

    const theirs = await gatherCompilerInput(otherDeviceId, NOW);
    expect(theirs.grants).toHaveLength(1);
  });

  it("includes a device-wide grant on every device", async () => {
    const f = await seed();
    await db.insert(overrides).values({
      householdId: f.householdId,
      childId: f.childId,
      deviceId: null,
      type: "extend",
      minutes: 30,
      effectiveDate: "2026-09-20",
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    const input = await gatherCompilerInput(f.deviceId, NOW);
    expect(input.grants).toHaveLength(1);
  });

  it("clips calendar exceptions to the 21-day horizon", async () => {
    const f = await seed();
    await db.insert(calendarExceptions).values([
      { householdId: f.householdId, childId: f.childId, day: "2026-09-25", effect: "no_bedtime" },
      { householdId: f.householdId, childId: f.childId, day: "2026-12-25", effect: "no_bedtime" },
    ]);
    const input = await gatherCompilerInput(f.deviceId, NOW);
    expect(input.exceptions.map((e) => e.day)).toEqual(["2026-09-25"]);
  });

  it("includes a household-wide exception (child_id NULL)", async () => {
    const f = await seed();
    await db.insert(calendarExceptions).values({
      householdId: f.householdId,
      childId: null,
      day: "2026-09-25",
      effect: "no_bedtime",
    });
    const input = await gatherCompilerInput(f.deviceId, NOW);
    expect(input.exceptions).toHaveLength(1);
  });

  it("reads crosses_midnight from the generated column rather than re-deriving", async () => {
    const f = await seed();
    const input = await gatherCompilerInput(f.deviceId, NOW);
    // 21:30 -> 07:00 wraps; Postgres computed this, not us.
    expect(input.windows.every((w) => w.crossesMidnight)).toBe(true);
  });

  it("passes no holidays when the household has no countries set", async () => {
    const f = await seed({ holidayCountries: null });
    const input = await gatherCompilerInput(f.deviceId, NOW);
    expect(input.holidays).toEqual([]);
  });

  it("resolves real holidays when countries are set", async () => {
    // The one place the live library is exercised. Asserts only that the
    // horizon window is respected and the shape is right — never a specific
    // holiday, which would rot.
    const f = await seed({ holidayCountries: ["US"] });
    const input = await gatherCompilerInput(f.deviceId, NOW);
    for (const h of input.holidays) {
      expect(h.date >= "2026-09-20" && h.date <= "2026-10-11", h.date).toBe(true);
      expect(typeof h.name).toBe("string");
    }
  });

  it("skips holidays entirely when holidays_enabled is false", async () => {
    const f = await seed({ holidayCountries: ["US"] });
    await db
      .update(households)
      .set({ holidaysEnabled: false })
      .where(eq(households.id, f.householdId));
    const input = await gatherCompilerInput(f.deviceId, NOW);
    expect(input.holidays).toEqual([]);
  });

  it("reports the next version as max + 1", async () => {
    const f = await seed();
    expect((await gatherCompilerInput(f.deviceId, NOW)).nextVersion).toBe(1);
    await publishPolicy({ deviceId: f.deviceId, reason: "enrol", now: NOW });
    expect((await gatherCompilerInput(f.deviceId, NOW)).nextVersion).toBe(2);
  });
});

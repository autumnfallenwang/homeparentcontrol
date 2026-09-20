import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "../db/index.js";
import {
  agentStatusIntervals,
  children,
  devices,
  events,
  expectedOnlineWindows,
  households,
  policySets,
  users,
} from "../db/schema.js";
import { evaluateLiveness } from "./liveness.js";

/**
 * §7.3's five-state machine and §7.4's gap attribution, against real Postgres.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** A Monday 20:00 UTC = 16:00 New York — inside a 07:00–21:45 weekday window. */
const NOW = new Date("2026-09-21T20:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

interface Fixture {
  householdId: string;
  deviceId: string;
  policySetId: string;
}

async function wipe(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users, households RESTART IDENTITY CASCADE`);
}

async function seed(over: Partial<typeof devices.$inferInsert> = {}): Promise<Fixture> {
  const householdId = randomUUID();
  const serviceUserId = randomUUID();
  const childId = randomUUID();
  const policySetId = randomUUID();
  const deviceId = randomUUID();

  await db.insert(users).values({
    id: serviceUserId,
    name: "svc",
    email: `svc+${householdId}@hpc.local`,
    isService: true,
  });
  await db.insert(households).values({ id: householdId, name: "T", serviceUserId });
  await db.insert(children).values({ id: childId, householdId, displayName: "Lucy" });
  await db.insert(policySets).values({ id: policySetId, householdId, childId });
  await db.insert(expectedOnlineWindows).values({
    householdId,
    policySetId,
    days: ["mon", "tue", "wed", "thu", "fri"],
    fromTime: "07:00",
    untilTime: "21:45",
  });
  await db.insert(devices).values({
    id: deviceId,
    householdId,
    childId,
    policySetId,
    label: "Mac",
    status: "active",
    lastSyncAt: ago(10_000),
    ...over,
  });
  return { householdId, deviceId, policySetId };
}

const stateOf = async (deviceId: string): Promise<string> => {
  const [row] = await db
    .select({ s: devices.healthState })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return row?.s ?? "";
};

const openInterval = async (deviceId: string) => {
  const [row] = await db
    .select()
    .from(agentStatusIntervals)
    .where(eq(agentStatusIntervals.deviceId, deviceId))
    .orderBy(desc(agentStatusIntervals.enteredAt))
    .limit(1);
  return row;
};

beforeEach(async () => {
  if (hasDb) await wipe();
});
afterAll(async () => {
  if (hasDb) {
    await wipe();
    await closeDb();
  }
});

d("the five-state machine — §7.3", () => {
  it("HEALTHY when the last tick is within 180 s", async () => {
    const f = await seed({ lastSyncAt: ago(60_000) });
    await evaluateLiveness(NOW);
    expect(await stateOf(f.deviceId)).toBe("HEALTHY");
  });

  it("DEGRADED when ticking but self-reporting an impairment", async () => {
    const f = await seed({ lastSyncAt: ago(60_000), selfReportedReason: "signature_invalid" });
    await evaluateLiveness(NOW);
    expect(await stateOf(f.deviceId)).toBe("DEGRADED");
    expect((await openInterval(f.deviceId))?.reason).toBe("signature_invalid");
  });

  it("UNEXPECTED_SILENCE after 10 min inside an expected-online window", async () => {
    const f = await seed({ lastSyncAt: ago(15 * 60_000) });
    await evaluateLiveness(NOW);
    expect(await stateOf(f.deviceId)).toBe("UNEXPECTED_SILENCE");
  });

  it("SILENT_TOO_LONG after 36 h", async () => {
    const f = await seed({ lastSyncAt: ago(40 * 3_600_000) });
    await evaluateLiveness(NOW);
    expect(await stateOf(f.deviceId)).toBe("SILENT_TOO_LONG");
  });

  it("EXPECTED_OFFLINE outside the window", async () => {
    // 03:00 UTC on a Monday = 23:00 Sunday New York, outside 07:00–21:45.
    const night = new Date("2026-09-21T03:00:00.000Z");
    const f = await seed({ lastSyncAt: new Date(night.getTime() - 20 * 60_000) });
    await evaluateLiveness(night);
    expect(await stateOf(f.deviceId)).toBe("EXPECTED_OFFLINE");
  });

  it("EXPECTED_OFFLINE after a clean agent.stopping", async () => {
    const f = await seed({ lastSyncAt: ago(20 * 60_000) });
    await db.insert(events).values({
      householdId: f.householdId,
      deviceId: f.deviceId,
      eventId: "018f2a4c-7b31-7c9e-9d2a-00000000000a",
      type: "agent.stopping",
      v: 1,
      class: "audit",
      ts: ago(20 * 60_000),
      // Set explicitly: the column defaults to the real clock, which is long
      // before this test's synthetic NOW.
      receivedAt: ago(20 * 60_000),
      bootId: "018f2a4c-0000-7000-8000-000000000001",
      seq: 1,
      data: {},
    });
    await evaluateLiveness(NOW);
    expect(await stateOf(f.deviceId)).toBe("EXPECTED_OFFLINE");
  });

  it("UNENROLLED while a device has never ticked", async () => {
    // A sixth state the schema has and §7.3's table does not.
    const f = await seed({ lastSyncAt: null, status: "enrolled" });
    await evaluateLiveness(NOW);
    expect(await stateOf(f.deviceId)).toBe("UNENROLLED");
  });

  it("skips a decommissioned device entirely", async () => {
    const f = await seed({ status: "decommissioned", lastSyncAt: ago(40 * 3_600_000) });
    const result = await evaluateLiveness(NOW);
    expect(result.evaluated).toBe(0);
    expect(await stateOf(f.deviceId)).toBe("UNENROLLED"); // untouched default
  });
});

/**
 * ★ §7.3 gives five overlapping conditions and NO evaluation order. These pin
 * the precedence that had to be invented.
 */
d("precedence, which §7.3 does not give", () => {
  /**
   * ⚠️ §7.3 says SILENT_TOO_LONG fires "regardless"; A.19/X6 and the schema
   * say `away_until` exists precisely so a school holiday cannot make it fire
   * benignly and get the channel muted. The purpose settles it.
   */
  it("away_until beats SILENT_TOO_LONG", async () => {
    const f = await seed({
      lastSyncAt: ago(40 * 3_600_000),
      awayUntil: new Date(NOW.getTime() + 86_400_000),
    });
    await evaluateLiveness(NOW);
    expect(await stateOf(f.deviceId)).toBe("EXPECTED_OFFLINE");
    expect((await openInterval(f.deviceId))?.reason).toBe("away");
  });

  it("a fresh tick beats being outside the window", async () => {
    const night = new Date("2026-09-21T03:00:00.000Z");
    const f = await seed({ lastSyncAt: new Date(night.getTime() - 30_000) });
    await evaluateLiveness(night);
    expect(await stateOf(f.deviceId)).toBe("HEALTHY");
  });

  it("SILENT_TOO_LONG beats being outside the window", async () => {
    const night = new Date("2026-09-21T03:00:00.000Z");
    const f = await seed({ lastSyncAt: new Date(night.getTime() - 40 * 3_600_000) });
    await evaluateLiveness(night);
    expect(await stateOf(f.deviceId)).toBe("SILENT_TOO_LONG");
  });

  /** ⚠️ The hole: HEALTHY is "within 180 s", UNEXPECTED_SILENCE is "10 min". */
  it("holds the current state in the 180 s – 10 min gap", async () => {
    const f = await seed({ lastSyncAt: ago(60_000) });
    await evaluateLiveness(NOW); // HEALTHY
    expect(await stateOf(f.deviceId)).toBe("HEALTHY");

    await db
      .update(devices)
      .set({ lastSyncAt: ago(5 * 60_000) })
      .where(eq(devices.id, f.deviceId));
    await evaluateLiveness(NOW);
    expect(await stateOf(f.deviceId), "no flap into anything else").toBe("HEALTHY");
  });
});

d("intervals — one row per state CHANGE", () => {
  it("writes an interval on entry and closes it on exit", async () => {
    const f = await seed({ lastSyncAt: ago(60_000) });
    await evaluateLiveness(NOW);

    await db
      .update(devices)
      .set({ lastSyncAt: ago(15 * 60_000) })
      .where(eq(devices.id, f.deviceId));
    // A minute later, so the two intervals have distinct entered_at and the
    // DESC ordering below is deterministic.
    await evaluateLiveness(new Date(NOW.getTime() + 60_000));

    const rows = await db
      .select()
      .from(agentStatusIntervals)
      .where(eq(agentStatusIntervals.deviceId, f.deviceId))
      .orderBy(desc(agentStatusIntervals.enteredAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.state).toBe("UNEXPECTED_SILENCE");
    expect(rows[0]?.exitedAt).toBeNull();
    expect(rows[1]?.state).toBe("HEALTHY");
    expect(rows[1]?.exitedAt, "the earlier one is closed").not.toBeNull();
  });

  it("does NOT write a row when the state is unchanged", async () => {
    // A row per device per minute would be ~69 MB at the 400-day ladder,
    // larger than the entire raw telemetry store.
    const f = await seed({ lastSyncAt: ago(60_000) });
    await evaluateLiveness(NOW);
    await evaluateLiveness(NOW);
    await evaluateLiveness(NOW);

    const rows = await db
      .select()
      .from(agentStatusIntervals)
      .where(eq(agentStatusIntervals.deviceId, f.deviceId));
    expect(rows).toHaveLength(1);
  });
});

d("notifications — §7.3's two escalation rules", () => {
  it("does not notify the moment UNEXPECTED_SILENCE is entered", async () => {
    // Enter amber at 10 min, buzz a phone at 60 — a macOS update restart
    // routinely exceeds 10 minutes on Apple silicon.
    const f = await seed({ lastSyncAt: ago(15 * 60_000) });
    await evaluateLiveness(NOW);
    expect((await openInterval(f.deviceId))?.notifiedAt).toBeNull();
  });

  it("notifies once the interval is 60 minutes old", async () => {
    const f = await seed({ lastSyncAt: ago(15 * 60_000) });
    await evaluateLiveness(NOW);
    await db
      .update(agentStatusIntervals)
      .set({ enteredAt: ago(90 * 60_000) })
      .where(eq(agentStatusIntervals.deviceId, f.deviceId));

    await evaluateLiveness(NOW);
    expect((await openInterval(f.deviceId))?.notifiedAt).not.toBeNull();
  });

  /**
   * ⚠️ §3.8 says the `agent.stopping` that would explain an overnight
   * shutdown is routinely lost. Without this suppression every night produces
   * a false amber, and an alert nobody wants is an alert nobody reads.
   */
  it("never notifies for silence outside an expected-online window", async () => {
    const night = new Date("2026-09-21T03:00:00.000Z");
    const f = await seed({ lastSyncAt: new Date(night.getTime() - 20 * 60_000) });
    await evaluateLiveness(night);
    await db
      .update(agentStatusIntervals)
      .set({ state: "UNEXPECTED_SILENCE", enteredAt: new Date(night.getTime() - 90 * 60_000) })
      .where(eq(agentStatusIntervals.deviceId, f.deviceId));

    await evaluateLiveness(night);
    expect((await openInterval(f.deviceId))?.notifiedAt).toBeNull();
  });

  it("notifies SILENT_TOO_LONG immediately", async () => {
    const f = await seed({ lastSyncAt: ago(40 * 3_600_000) });
    await evaluateLiveness(NOW);
    expect((await openInterval(f.deviceId))?.notifiedAt).not.toBeNull();
  });

  it("never notifies for EXPECTED_OFFLINE", async () => {
    const f = await seed({
      lastSyncAt: ago(40 * 3_600_000),
      awayUntil: new Date(NOW.getTime() + 86_400_000),
    });
    await evaluateLiveness(NOW);
    await evaluateLiveness(NOW);
    expect((await openInterval(f.deviceId))?.notifiedAt).toBeNull();
  });
});

/**
 * ★ §7.4 — off vs broken, with no probe. A.29 forbids pinging the Mac: a
 * Bonjour Sleep Proxy answers ARP for a sleeping machine, so the probe lies.
 */
d("gap attribution — §7.4", () => {
  it("reclassifies a silence the boot time explains", async () => {
    const f = await seed({ lastSyncAt: ago(15 * 60_000) });
    await evaluateLiveness(NOW); // enters UNEXPECTED_SILENCE

    // The Mac comes back, reporting a boot INSIDE the silence window.
    const interval = await openInterval(f.deviceId);
    await db
      .update(agentStatusIntervals)
      .set({ enteredAt: ago(30 * 60_000), exitedAt: ago(60_000) })
      .where(eq(agentStatusIntervals.id, interval?.id as string));
    await db
      .update(devices)
      .set({ lastSyncAt: ago(30_000), systemBootTime: ago(10 * 60_000) })
      .where(eq(devices.id, f.deviceId));

    const result = await evaluateLiveness(NOW);
    expect(result.reclassified).toBe(1);

    const [row] = await db
      .select()
      .from(agentStatusIntervals)
      .where(eq(agentStatusIntervals.id, interval?.id as string));
    expect(row?.state).toBe("EXPECTED_OFFLINE");
    expect(row?.reclassifiedFrom, "the original verdict is kept").toBe("UNEXPECTED_SILENCE");
  });

  it("leaves a silence the boot time does NOT explain", async () => {
    // Boot time earlier than the silence: the Mac was up and the agent was
    // not. That is the tamper signal, and it must not be explained away.
    const f = await seed({ lastSyncAt: ago(15 * 60_000) });
    await evaluateLiveness(NOW);

    const interval = await openInterval(f.deviceId);
    await db
      .update(agentStatusIntervals)
      .set({ enteredAt: ago(30 * 60_000), exitedAt: ago(60_000) })
      .where(eq(agentStatusIntervals.id, interval?.id as string));
    await db
      .update(devices)
      .set({ lastSyncAt: ago(30_000), systemBootTime: ago(10 * 3_600_000) })
      .where(eq(devices.id, f.deviceId));

    const result = await evaluateLiveness(NOW);
    expect(result.reclassified).toBe(0);

    const [row] = await db
      .select()
      .from(agentStatusIntervals)
      .where(eq(agentStatusIntervals.id, interval?.id as string));
    expect(row?.state).toBe("UNEXPECTED_SILENCE");
  });
});

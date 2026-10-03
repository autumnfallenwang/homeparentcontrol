import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "../db/index.js";
import {
  agentStatusIntervals,
  children,
  devices,
  enforcementLog,
  events,
  households,
  policySets,
  policyVersions,
  usageDaily,
  users,
} from "../db/schema.js";
import { projectEvents } from "../jobs/project.js";
import { HISTORY_TEXT, loadHistory } from "./history.js";
import { reportQuery } from "./report-query.js";

/**
 * `history.ts` against real Postgres: rows the projector wrote from real
 * events, plus the `power_on` row the sync handler writes, read back through
 * the same loader the device page and Activity use.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** Per-PROCESS, as the agent really sends it — nothing may read it as a boot. */
const PROCESS_ID = "process-1";
const T0 = new Date("2026-09-20T21:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

interface Fixture {
  householdId: string;
  childId: string;
  deviceId: string;
}

async function wipe(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE users, households, projection_state RESTART IDENTITY CASCADE`,
  );
}

async function seed(): Promise<Fixture> {
  const householdId = randomUUID();
  const serviceUserId = randomUUID();
  await db.insert(users).values({
    id: serviceUserId,
    name: "svc",
    email: `svc+${householdId}@hpc.local`,
    isService: true,
  });
  await db.insert(households).values({ id: householdId, name: "T", serviceUserId });
  return { householdId, ...(await addChild(householdId, "Ivy")) };
}

async function addChild(householdId: string, name: string) {
  const childId = randomUUID();
  const deviceId = randomUUID();
  await db.insert(children).values({ id: childId, householdId, displayName: name });
  await db.insert(policySets).values({ householdId, childId });
  await db.insert(devices).values({ id: deviceId, householdId, childId, label: `${name}'s Mac` });
  return { childId, deviceId };
}

let seq = 0;
async function emit(
  f: { householdId: string; deviceId: string },
  type: string,
  data: Record<string, unknown>,
  at: Date,
) {
  seq++;
  await db.insert(events).values({
    householdId: f.householdId,
    deviceId: f.deviceId,
    eventId: `018f2a4c-7b31-7c9e-9d2a-${seq.toString(16).padStart(12, "0")}`,
    type,
    v: 1,
    class: "audit",
    ts: at,
    bootId: PROCESS_ID,
    seq,
    data,
  });
}

/** Ivy's test on 28 Sep, shrunk: installed, a bedtime shutdown, turned back on. */
async function bedtimeCycle(f: { householdId: string; childId: string; deviceId: string }) {
  await emit(f, "agent.started", { clean_exit_previous_run: "false" }, minutes(0));
  await emit(f, "enforcement.action_taken", { action: "lock" }, minutes(10));
  await emit(f, "enforcement.action_taken", { action: "shutdown" }, minutes(11));
  await emit(f, "agent.stopping", { reason: "signal" }, minutes(11));
  await emit(f, "agent.stopping", { reason: "signal" }, minutes(11));
  // What `recordPowerOn` in routes/sync.ts writes when the uptime drops.
  await db.insert(enforcementLog).values({
    householdId: f.householdId,
    deviceId: f.deviceId,
    childId: f.childId,
    eventId: randomUUID(),
    kind: "power_on",
    occurredAt: minutes(19),
    summary: "Mac turned on",
    detail: { source: "server" },
  });
  await emit(f, "agent.started", { clean_exit_previous_run: "true" }, minutes(20));
}

beforeEach(async () => {
  if (hasDb) await wipe();
  seq = 0;
});
afterAll(async () => {
  if (hasDb) {
    await wipe();
    await closeDb();
  }
});

d("history, projected from real events", () => {
  it("★ a bedtime shutdown and the server's power-on read as two plain lines — no watch hours, nothing red", async () => {
    const f = await seed();
    await bedtimeCycle(f);
    await projectEvents();

    const history = await loadHistory({
      householdId: f.householdId,
      deviceId: f.deviceId,
      from: minutes(-60),
    });
    const story = history.rows.map(
      (row) => `${row.summary}${row.tone === "alarm" ? " [red]" : ""}`,
    );
    expect(story.reverse()).toEqual([
      HISTORY_TEXT.started,
      "Enforced: lock",
      HISTORY_TEXT.shutDownAtBedtime,
      HISTORY_TEXT.turnedOn,
    ]);
    expect(history.startups).toBe(1);
  });

  it("★ a window that starts mid-story still knows the device had history before it", async () => {
    const f = await seed();
    await bedtimeCycle(f);
    await projectEvents();
    // Only the power-on and the boot's launch are inside the window.
    const history = await loadHistory({
      householdId: f.householdId,
      deviceId: f.deviceId,
      from: minutes(15),
    });
    expect(history.rows.map((row) => row.summary)).toEqual([HISTORY_TEXT.turnedOn]);
  });

  it("the report counts startups for the child, and only that child", async () => {
    const f = await seed();
    const other = await addChild(f.householdId, "Aaron");
    await bedtimeCycle(f);
    await bedtimeCycle({ householdId: f.householdId, ...other });
    await projectEvents();

    const payload = await reportQuery({
      householdId: f.householdId,
      childId: f.childId,
      from: minutes(-60),
      to: minutes(60),
      grain: "hour",
    });
    expect(payload.totals.startups).toBe(1);
    expect(payload.enforcement.every((row) => row.deviceId === f.deviceId)).toBe(true);
  });

  it("★ a child's report reads only that child's health gaps", async () => {
    const f = await seed();
    const other = await addChild(f.householdId, "Aaron");
    await db.insert(agentStatusIntervals).values({
      householdId: f.householdId,
      deviceId: other.deviceId,
      state: "UNEXPECTED_SILENCE",
      reason: "silent_10m",
      enteredAt: minutes(0),
      exitedAt: minutes(30),
    });
    const payload = await reportQuery({
      householdId: f.householdId,
      childId: f.childId,
      from: minutes(-60),
      to: minutes(60),
      grain: "hour",
    });
    expect(payload.gaps).toEqual([]);
  });

  /**
   * ★ #5, "Active time 0 m" for both children on 28 Sep. The daily grain
   * filtered `local_day < day(to)`, and `to` is NOW — so the day in progress,
   * the only day two Macs set up that morning had, was never counted.
   */
  it("★ the daily grain counts the day that is still in progress", async () => {
    const f = await seed();
    const now = new Date();
    await db.insert(usageDaily).values({
      householdId: f.householdId,
      deviceId: f.deviceId,
      childId: f.childId,
      localDay: now.toISOString().slice(0, 10),
      bundleId: "com.apple.Safari",
      foregroundS: 600,
      activeS: 480,
    });
    const payload = await reportQuery({
      householdId: f.householdId,
      childId: f.childId,
      from: new Date(now.getTime() - 7 * 86_400_000),
      to: now,
      grain: "day",
    });
    expect(payload.totals.activeS).toBe(480);
  });

  /**
   * ★ ADR 0014 end to end: a real compiled document with a watch period,
   * judged by the rules in force at the moment, through the real loader.
   */
  it("★ a startup and an unlock during watch hours are red, and counted; the rest is not", async () => {
    const f = await seed();
    const [set] = await db
      .select({ id: policySets.id })
      .from(policySets)
      .where(eq(policySets.childId, f.childId));
    // Every night: enforced 21:00–21:05 UTC, then watched until 23:00.
    await db.insert(policyVersions).values({
      householdId: f.householdId,
      deviceId: f.deviceId,
      policySetId: set?.id ?? "",
      version: 1,
      documentHash: "test",
      etag: 'W/"pol-test-v1"',
      notBefore: minutes(-600),
      document: {
        timezone: "UTC",
        schedule: {
          kind: "windows",
          windows: [
            {
              id: "5f0b1b7c-0000-4000-8000-000000000001",
              label: "School nights",
              days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
              restricted_from: "21:00",
              restricted_until: "21:05",
              watch_until: "23:00",
            },
          ],
        },
        overrides: [],
      },
    });
    // T0 is 21:00 UTC. Locked at bedtime, turned on at 21:30, unlocked at
    // 21:40, and in the afternoon an unlock that must not be listed.
    //
    // ⚠️ The lock at 21:00 is what a real enforcer records. This fixture used
    // to lock only at 21:10 — leaving the afternoon's unlock open straight
    // through the 21:00–21:05 window, which ADR 0015 correctly reads as
    // "in use during bedtime". That case has its own test, below.
    await emit(f, "session.state", { state: "locked" }, minutes(0));
    await emit(f, "session.state", { state: "locked" }, minutes(10));
    await db.insert(enforcementLog).values({
      householdId: f.householdId,
      deviceId: f.deviceId,
      childId: f.childId,
      eventId: randomUUID(),
      kind: "power_on",
      occurredAt: minutes(30),
      summary: "Mac turned on",
      detail: { source: "server" },
    });
    await emit(f, "session.state", { state: "awake" }, minutes(40));
    await emit(f, "session.state", { state: "locked" }, minutes(-300));
    await emit(f, "session.state", { state: "awake" }, minutes(-290));
    await projectEvents();

    const payload = await reportQuery({
      householdId: f.householdId,
      childId: f.childId,
      from: minutes(-360),
      to: minutes(180),
      grain: "hour",
    });
    const red = payload.enforcement.filter((row) => row.tone === "alarm").map((row) => row.summary);
    expect(red.sort()).toEqual([
      "Mac turned on during School nights's watch hours",
      "Mac unlocked during School nights's watch hours",
    ]);
    expect(payload.totals.afterBedtime).toBe(2);
    expect(payload.totals.startups).toBe(1);
    // The afternoon unlock is not listed at all.
    expect(payload.enforcement.filter((row) => row.kind === "session_unlocked")).toHaveLength(1);
  });

  /**
   * ★ ADR 0015 end to end: the Mac never locked at bedtime — whatever the
   * trick — and was unlocked through the window. Red, through the real loader.
   */
  it("★ unlocked straight through an enforced window is red: in use during bedtime", async () => {
    const f = await seed();
    const [set] = await db
      .select({ id: policySets.id })
      .from(policySets)
      .where(eq(policySets.childId, f.childId));
    await db.insert(policyVersions).values({
      householdId: f.householdId,
      deviceId: f.deviceId,
      policySetId: set?.id ?? "",
      version: 1,
      documentHash: "test",
      etag: 'W/"pol-test-v1"',
      notBefore: minutes(-600),
      document: {
        timezone: "UTC",
        schedule: {
          kind: "windows",
          windows: [
            {
              id: "5f0b1b7c-0000-4000-8000-000000000001",
              label: "School nights",
              days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
              restricted_from: "21:00",
              restricted_until: "21:30",
              action: "shutdown",
              action_options: { shutdown_grace_s: 300, escalate_after_failures: 3 },
            },
          ],
        },
        overrides: [],
      },
    });
    // Unlocked at 20:50 and never locked: no lock at 21:00, no shutdown at 21:05.
    await emit(f, "session.state", { state: "locked" }, minutes(-20));
    await emit(f, "session.state", { state: "awake" }, minutes(-10));
    await emit(f, "session.state", { state: "locked" }, minutes(40));
    await projectEvents();

    const payload = await reportQuery({
      householdId: f.householdId,
      childId: f.childId,
      from: minutes(-60),
      to: minutes(120),
      grain: "hour",
    });
    const red = payload.enforcement.filter((row) => row.tone === "alarm");
    expect(red.map((row) => row.summary)).toEqual([
      "Mac in use during School nights's bedtime — it should have been off",
    ]);
    // At the first moment it should not have been possible: 21:05 shutdown + 2 min.
    expect(red[0]?.at).toBe(minutes(7).toISOString());
    expect(payload.totals.afterBedtime).toBe(1);
  });
});

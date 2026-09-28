import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "../db/index.js";
import {
  agentStatusIntervals,
  children,
  devices,
  events,
  households,
  policySets,
  users,
} from "../db/schema.js";
import { projectEvents } from "../jobs/project.js";
import { HISTORY_TEXT, loadHistory } from "./history.js";
import { reportQuery } from "./report-query.js";

/**
 * `history.ts` against real Postgres: the boot ID it decides "turned on" by
 * comes from a JOIN to `events`, which the pure tests cannot exercise.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const BOOT_A = "boot-aaaa";
const BOOT_B = "boot-bbbb";
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
  bootId: string,
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
    bootId,
    seq,
    data,
  });
}

/** Ivy's test on 28 Sep, shrunk: installed, a bedtime shutdown, turned back on. */
async function bedtimeCycle(f: { householdId: string; deviceId: string }) {
  await emit(f, "agent.started", { clean_exit_previous_run: "false" }, minutes(0), BOOT_A);
  await emit(f, "enforcement.action_taken", { action: "lock" }, minutes(10), BOOT_A);
  await emit(f, "enforcement.action_taken", { action: "shutdown" }, minutes(11), BOOT_A);
  await emit(f, "agent.stopping", { reason: "signal" }, minutes(11), BOOT_A);
  await emit(f, "agent.stopping", { reason: "signal" }, minutes(11), BOOT_A);
  await emit(f, "agent.started", { clean_exit_previous_run: "true" }, minutes(20), BOOT_B);
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
  it("★ a bedtime shutdown and power-on come out as the red lines, via the boot join", async () => {
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
      `${HISTORY_TEXT.shutDownAtBedtime} [red]`,
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
    expect(history.startups).toBe(1);
  });

  it("★ a window that starts mid-story still knows the boot before it", async () => {
    const f = await seed();
    await bedtimeCycle(f);
    await projectEvents();
    // Only the power-on is inside the window; the boot before it is not.
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
    await bedtimeCycle({ householdId: f.householdId, deviceId: other.deviceId });
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
});

import { randomUUID } from "node:crypto";
import { CONTRACT_MINOR } from "@hpc/contract";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { closeDb, db } from "../db/index.js";
import {
  children,
  devices,
  events,
  households,
  policySets,
  scheduleWindows,
  users,
} from "../db/schema.js";
import { mintDeviceKey } from "../lib/device-keys.js";
import { publishPolicy } from "../policy/publish.js";

/**
 * `POST /events` — telemetry ingest. Against real Postgres, because the whole
 * endpoint is one `ON CONFLICT` away from being wrong.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const app = createApp();
const BATCH_BOOT = "018f2a4c-0000-7000-8000-000000000001";

interface Fixture {
  deviceId: string;
  token: string;
}

/** A canonical lowercase UUIDv7, which is the only spelling X5 allows. */
function eventId(n: number): string {
  return `018f2a4c-7b31-7c9e-9d2a-${n.toString(16).padStart(12, "0")}`;
}

function evt(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: eventId(n),
    type: "enforcement.lock",
    v: 1,
    class: "audit",
    ts: "2026-09-20T21:30:00.000Z",
    seq: n,
    data: { window_id: "abc" },
    ...over,
  };
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
  });

  const credential = await mintDeviceKey({
    serviceUserId,
    deviceId,
    householdId,
    label: "Lucy's Mac mini",
  });
  await db.update(devices).set({ apiKeyId: credential.keyId }).where(eq(devices.id, deviceId));
  await publishPolicy({ deviceId, reason: "enrol" });

  return { deviceId, token: credential.token };
}

async function post(
  token: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request("/api/agent/v1/events", {
    method: "POST",
    headers: { "x-api-key": token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = res.status === 204 ? {} : ((await res.json()) as Record<string, unknown>);
  return { status: res.status, body: parsed };
}

const batch = (deviceId: string, list: unknown[]) => ({
  contract: CONTRACT_MINOR,
  device_id: deviceId,
  boot_id: BATCH_BOOT,
  events: list,
});

async function storedCount(deviceId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(eq(events.deviceId, deviceId));
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

d("POST /events — ingest", () => {
  it("accepts a batch with 202 and stores every event", async () => {
    const f = await seed();
    const { status, body } = await post(f.token, batch(f.deviceId, [evt(1), evt(2), evt(3)]));

    expect(status).toBe(202);
    expect(body.contract).toBe(CONTRACT_MINOR);
    expect(body.accepted_event_ids).toHaveLength(3);
    expect(body.rejected_events).toEqual([]);
    expect(body.next_batch_allowed_in_ms).toBe(0);
    expect(await storedCount(f.deviceId)).toBe(3);
  });

  it("an empty batch is a 202, not an error", async () => {
    const f = await seed();
    const { status, body } = await post(f.token, batch(f.deviceId, []));
    expect(status).toBe(202);
    expect(body.accepted_event_ids).toEqual([]);
  });

  it("records received_at itself and stores ts exactly as sent", async () => {
    const f = await seed();
    // An implausible ts IS the evidence a clock was stepped — no clamp.
    await post(f.token, batch(f.deviceId, [evt(1, { ts: "2001-01-01T00:00:00.000Z" })]));

    const [row] = await db.select().from(events).where(eq(events.deviceId, f.deviceId));
    expect(row?.ts.toISOString()).toBe("2001-01-01T00:00:00.000Z");
    expect(row?.receivedAt.getFullYear()).toBeGreaterThan(2020);
  });

  it("stores data verbatim without interpreting it", async () => {
    const f = await seed();
    await post(f.token, batch(f.deviceId, [evt(1, { data: { anything: { nested: [1, 2] } } })]));
    const [row] = await db.select().from(events).where(eq(events.deviceId, f.deviceId));
    expect(row?.data).toEqual({ anything: { nested: [1, 2] } });
  });
});

/**
 * ★ The trap. `ON CONFLICT DO NOTHING RETURNING` yields only NEW rows, so the
 * implementation that falls out of the SQL is the wrong one — and its failure
 * is silent: the agent re-sends, the server accepts, nothing errors, and the
 * queue never drains.
 */
d("POST /events — idempotency", () => {
  it("re-sending the same batch stores nothing new", async () => {
    const f = await seed();
    const b = batch(f.deviceId, [evt(1), evt(2)]);

    expect((await post(f.token, b)).status).toBe(202);
    expect((await post(f.token, b)).status).toBe(202);
    expect(await storedCount(f.deviceId)).toBe(2);
  });

  it("a CONFLICTING event is still reported as accepted", async () => {
    // "Returning only newly-inserted rows would make the agent retry the same
    // batch forever."
    const f = await seed();
    const b = batch(f.deviceId, [evt(1), evt(2)]);

    const first = await post(f.token, b);
    const second = await post(f.token, b);

    expect(second.body.accepted_event_ids).toEqual(first.body.accepted_event_ids);
    expect(second.body.accepted_event_ids).toHaveLength(2);
  });

  it("accepts the already-durable half of a partially-new batch", async () => {
    const f = await seed();
    await post(f.token, batch(f.deviceId, [evt(1)]));
    const { body } = await post(f.token, batch(f.deviceId, [evt(1), evt(2)]));

    expect(body.accepted_event_ids).toHaveLength(2);
    expect(await storedCount(f.deviceId)).toBe(2);
  });
});

d("POST /events — per-event rejection", () => {
  it("takes the good events and rejects only the bad one", async () => {
    // §5.7 — "validate per event, not per batch, so 'I took 1,998 of your
    // 2,000' is expressible."
    const f = await seed();
    const { status, body } = await post(
      f.token,
      batch(f.deviceId, [evt(1), evt(2), { nonsense: true }, evt(3)]),
    );

    expect(status).toBe(202);
    expect(body.accepted_event_ids).toHaveLength(3);
    expect(body.rejected_events).toHaveLength(1);
    expect(await storedCount(f.deviceId)).toBe(3);
  });

  it("every rejection is retryable: false", async () => {
    const f = await seed();
    const { body } = await post(f.token, batch(f.deviceId, [{ nonsense: true }]));
    const rejected = body.rejected_events as { retryable: boolean }[];
    expect(rejected[0]?.retryable).toBe(false);
  });

  /** X5 — the server REJECTS rather than normalising. */
  it("rejects an uppercase event_id and writes no row under either spelling", async () => {
    const f = await seed();
    const upper = eventId(1).toUpperCase();
    const { status, body } = await post(f.token, batch(f.deviceId, [evt(1, { event_id: upper })]));

    expect(status).toBe(202);
    const rejected = body.rejected_events as { event_id: string; reason: string }[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("bad_event_id_format");
    // Echoed back as submitted, so the agent knows which queued event to drop.
    expect(rejected[0]?.event_id).toBe(upper);
    // ⚠️ The point: no row, under either spelling. A normaliser would have
    // stored it and kept the two-spelling hazard alive.
    expect(await storedCount(f.deviceId)).toBe(0);
  });

  it("rejects a non-UUIDv7 event_id", async () => {
    const f = await seed();
    const { body } = await post(
      f.token,
      batch(f.deviceId, [evt(1, { event_id: "018f2a4c-7b31-4c9e-9d2a-000000000001" })]), // v4
    );
    expect((body.rejected_events as { reason: string }[])[0]?.reason).toBe("bad_event_id_format");
  });

  it("rejects an unknown class — it has no retention policy", async () => {
    // The narrow exception to R8's never-reject: `sample` is 90 days and
    // `audit` is 400, so anything else creates rows the pruner never touches.
    const f = await seed();
    const { body } = await post(f.token, batch(f.deviceId, [evt(1, { class: "debug" })]));
    expect((body.rejected_events as { reason: string }[])[0]?.reason).toBe("bad_event_class");
    expect(await storedCount(f.deviceId)).toBe(0);
  });
});

/** R8 — the rule that makes D.1 and D.2 safe to defer. */
d("POST /events — R8, store first", () => {
  it("stores an unknown type verbatim rather than rejecting it", async () => {
    const f = await seed();
    const { status, body } = await post(
      f.token,
      batch(f.deviceId, [evt(1, { type: "something.nobody.has.written.yet" })]),
    );

    expect(status).toBe(202);
    expect(body.rejected_events).toEqual([]);
    const [row] = await db.select().from(events).where(eq(events.deviceId, f.deviceId));
    expect(row?.type).toBe("something.nobody.has.written.yet");
  });

  it("keeps a type the projector cannot yet handle", async () => {
    const f = await seed();
    await post(f.token, batch(f.deviceId, [evt(1, { type: "app.usage_sample" })]));
    expect(await storedCount(f.deviceId)).toBe(1);
  });
});

d("POST /events — boot_id ordering", () => {
  it("falls back to the batch's boot_id", async () => {
    const f = await seed();
    await post(f.token, batch(f.deviceId, [evt(1)]));
    const [row] = await db.select().from(events).where(eq(events.deviceId, f.deviceId));
    expect(row?.bootId).toBe(BATCH_BOOT);
  });

  /**
   * The reason the field exists: the agent's queue is durable across reboots,
   * so a post-reboot drain carries events from an earlier boot.
   */
  it("a per-event boot_id wins over the batch's", async () => {
    const f = await seed();
    const older = "018f2a4c-0000-7000-8000-000000000000";
    await post(f.token, batch(f.deviceId, [evt(1, { boot_id: older }), evt(2)]));

    const rows = await db
      .select({ seq: events.seq, bootId: events.bootId })
      .from(events)
      .where(eq(events.deviceId, f.deviceId));
    expect(rows.find((r) => r.seq === 1)?.bootId).toBe(older);
    expect(rows.find((r) => r.seq === 2)?.bootId).toBe(BATCH_BOOT);
  });
});

d("POST /events — batch-level failures", () => {
  it("413 on a batch over the cap, which maps to halve_batch", async () => {
    const f = await seed();
    const many = Array.from({ length: 2001 }, (_, i) => evt(i + 1));
    const { status, body } = await post(f.token, batch(f.deviceId, many));
    expect(status).toBe(413);
    expect(body.hpc_action).toBe("halve_batch");
  });

  it("400 / drop_batch on a body that is not a batch", async () => {
    const f = await seed();
    const { status, body } = await post(f.token, { garbage: true });
    expect(status).toBe(400);
    expect(body.hpc_action).toBe("drop_batch");
  });

  it("never emits 422 — one bad event cannot fail the request", async () => {
    const f = await seed();
    const { status } = await post(f.token, batch(f.deviceId, [{ nope: 1 }, { nope: 2 }]));
    expect(status).toBe(202);
  });

  it("403 when device_id is not the credential's", async () => {
    const f = await seed();
    const { status, body } = await post(f.token, batch(randomUUID(), [evt(1)]));
    expect(status).toBe(403);
    expect(body.hpc_action).toBe("halt_sync_keep_enforcing");
  });

  it("401 with no credential, and enforcement continues — X1b", async () => {
    await seed();
    const res = await app.request("/api/agent/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

d("POST /events — a decommissioned device", () => {
  it("can still post its final audit event", async () => {
    // §5.5 retains ALL telemetry: "the child's history is not the device's
    // property". Refusing would discard the record of the decommission.
    const f = await seed();
    await db.update(devices).set({ status: "decommissioned" }).where(eq(devices.id, f.deviceId));

    const { status } = await post(
      f.token,
      batch(f.deviceId, [evt(1, { type: "agent.decommissioned" })]),
    );
    expect(status).toBe(202);
    expect(await storedCount(f.deviceId)).toBe(1);
  });

  it("but still cannot sync", async () => {
    const f = await seed();
    await db.update(devices).set({ status: "decommissioned" }).where(eq(devices.id, f.deviceId));

    const res = await app.request("/api/agent/v1/sync", {
      method: "POST",
      headers: { "x-api-key": f.token, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).hpc_action).toBe("decommission");
  });
});

/**
 * ★ A.27 exists so "a 413 / 429 / poisoned batch must never make a live agent
 * look silent". The converse follows and the spec never states it: a draining
 * queue must not make a DEAD agent look alive.
 */
d("POST /events is not a heartbeat", () => {
  it("never touches last_sync_at or health_state", async () => {
    const f = await seed();
    const before = await db.select().from(devices).where(eq(devices.id, f.deviceId));

    await post(f.token, batch(f.deviceId, [evt(1), evt(2)]));
    await post(f.token, batch(f.deviceId, [{ bad: true }]));
    await post(f.token, batch(f.deviceId, []));

    const after = await db.select().from(devices).where(eq(devices.id, f.deviceId));
    expect(after[0]?.lastSyncAt).toBeNull();
    expect(after[0]?.healthState).toBe("UNENROLLED");
    expect(after).toEqual(before);
  });
});

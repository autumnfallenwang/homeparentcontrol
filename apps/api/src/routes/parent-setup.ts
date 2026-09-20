import { and, eq, isNull, ne } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { children, devices, enrollments, policySets } from "../db/schema.js";
import {
  ENROLMENT_TTL_MINUTES,
  enrolmentCodeHint,
  generateEnrolmentCode,
  hashEnrolmentCode,
  normaliseEnrolmentCode,
} from "../lib/enrolment-codes.js";
import { log } from "../lib/logger.js";
import { fail, type ParentVariables } from "./parent-context.js";

/**
 * `/setup` — add a child, add a Mac, get a code to type into the installer.
 *
 * ⚠️ **The code is shown ONCE and never retrievable.** `enrollments` stores
 * only a SHA-256 and a four-character hint, so "which code was that?" is
 * answerable and "what was the code?" is not. A code a parent can look up
 * later is a code sitting in a database waiting to enrol something else.
 */

const childBody = z.object({
  display_name: z.string().min(1).max(60),
  /** IANA. Falls back to the household's. */
  timezone: z.string().min(1).optional(),
});

/** `POST /api/parent/v1/children` */
export async function handleCreateChild(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const parsed = childBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, "malformed child");

  const [child] = await db
    .insert(children)
    .values({
      householdId,
      displayName: parsed.data.display_name,
      timezone: parsed.data.timezone ?? null,
    })
    .returning({ id: children.id });
  if (!child) return fail(c, 409, "the child was not created");

  // Every child needs a policy set, or there is nothing to compile.
  const [set] = await db
    .insert(policySets)
    .values({ householdId, childId: child.id })
    .returning({ id: policySets.id });

  return c.json({ child_id: child.id, policy_set_id: set?.id ?? null }, 201);
}

const deviceBody = z.object({
  child_id: z.uuid(),
  label: z.string().min(1).max(80),
});

/**
 * `POST /api/parent/v1/devices` — register a Mac and mint its one-time code.
 *
 * ⚠️ The device row is created `pending` with **no credential**. The
 * credential is minted by `/enroll` when the agent presents the code, which
 * is what makes the code the only secret that ever has to travel.
 */
export async function handleCreateDevice(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const user = c.get("user");
  const parsed = deviceBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, "malformed device");

  const [child] = await db
    .select({ id: children.id })
    .from(children)
    .where(and(eq(children.id, parsed.data.child_id), eq(children.householdId, householdId)))
    .limit(1);
  if (!child) return fail(c, 404, "no such child");

  const [set] = await db
    .select({ id: policySets.id })
    .from(policySets)
    .where(and(eq(policySets.childId, child.id), eq(policySets.householdId, householdId)))
    .limit(1);
  if (!set) return fail(c, 409, "that child has no policy set");

  const [device] = await db
    .insert(devices)
    .values({
      householdId,
      childId: child.id,
      policySetId: set.id,
      label: parsed.data.label,
      status: "pending",
    })
    .returning({ id: devices.id });
  if (!device) return fail(c, 409, "the device was not created");

  const issued = await issueCode(householdId, device.id, user.id);
  return c.json({ device_id: device.id, ...issued }, 201);
}

/**
 * `POST /api/parent/v1/devices/:id/enrolment-code` — re-issue.
 *
 * ⚠️ Refuses once the device has enrolled. §5.5's re-issue guard compares
 * `consumed_hardware_uuid`; handing out a fresh code for a live device would
 * let a second machine take over its identity, and the first one would keep
 * enforcing with a credential nobody knows about.
 */
export async function handleReissueCode(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const user = c.get("user");
  const deviceId = c.req.param("id");
  if (!deviceId) return fail(c, 400, "missing device id");

  const [device] = await db
    .select({ id: devices.id, status: devices.status })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.householdId, householdId)))
    .limit(1);
  if (!device) return fail(c, 404, "no such device");

  if (device.status !== "pending") {
    return fail(
      c,
      409,
      `this device is ${device.status}; revoke it first if you need to re-enrol it`,
    );
  }

  // Retire any outstanding unconsumed code — two live codes for one device
  // is two ways in.
  await db
    .delete(enrollments)
    .where(and(eq(enrollments.deviceId, device.id), isNull(enrollments.consumedAt)));

  const issued = await issueCode(householdId, device.id, user.id);
  return c.json({ device_id: device.id, ...issued });
}

async function issueCode(householdId: string, deviceId: string, userId: string) {
  const code = generateEnrolmentCode();
  const normalised = normaliseEnrolmentCode(code);
  if (!normalised) throw new Error("generated a code the normaliser rejects");

  const expiresAt = new Date(Date.now() + ENROLMENT_TTL_MINUTES * 60_000);
  await db.insert(enrollments).values({
    householdId,
    deviceId,
    codeHash: hashEnrolmentCode(normalised),
    codeHint: enrolmentCodeHint(normalised),
    expiresAt,
    createdBy: userId,
  });

  log.info(
    { event: "enrolment.code_issued", device_id: deviceId, hint: enrolmentCodeHint(normalised) },
    "issued an enrolment code",
  );

  return {
    // ★ Shown once. Nothing stores it.
    code,
    expires_at: expiresAt.toISOString(),
    ttl_minutes: ENROLMENT_TTL_MINUTES,
  };
}

/** `GET /api/parent/v1/setup` — what still needs doing. */
export async function handleSetupState(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");

  const [childRows, deviceRows, pendingCodes] = await Promise.all([
    db
      .select({ id: children.id, displayName: children.displayName, timezone: children.timezone })
      .from(children)
      .where(eq(children.householdId, householdId)),
    db
      .select({
        id: devices.id,
        label: devices.label,
        status: devices.status,
        childId: devices.childId,
      })
      .from(devices)
      .where(eq(devices.householdId, householdId)),
    db
      .select({
        deviceId: enrollments.deviceId,
        hint: enrollments.codeHint,
        expiresAt: enrollments.expiresAt,
        attempts: enrollments.attempts,
      })
      .from(enrollments)
      .where(and(eq(enrollments.householdId, householdId), isNull(enrollments.consumedAt))),
  ]);

  return c.json({
    children: childRows,
    devices: deviceRows,
    // The hint only — "HPC-K7QM…" — so a parent can tell which slip of paper
    // is which without the code being recoverable.
    pending_codes: pendingCodes.map((row) => ({
      device_id: row.deviceId,
      hint: row.hint,
      expires_at: row.expiresAt.toISOString(),
      attempts: row.attempts,
      expired: row.expiresAt < new Date(),
    })),
    next_step:
      childRows.length === 0
        ? "add_child"
        : deviceRows.length === 0
          ? "add_device"
          : deviceRows.every((device) => device.status !== "pending")
            ? "done"
            : "enrol_device",
  });
}

/** `GET /api/parent/v1/settings` */
export async function handleGetSettings(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const sets = await db.select().from(policySets).where(eq(policySets.householdId, householdId));
  const childRows = await db.select().from(children).where(eq(children.householdId, householdId));
  return c.json({ children: childRows, policy_sets: sets });
}

const settingsBody = z.object({
  policy_set_id: z.uuid(),
  override_enabled: z.boolean().optional(),
  override_max_minutes_per_day: z.int().min(0).max(480).optional(),
  override_max_grants_per_day: z.int().min(0).max(10).optional(),
  telemetry_enabled: z.boolean().optional(),
});

/**
 * `PATCH /api/parent/v1/settings`
 *
 * ⚠️ **A.34 — the schema cannot express an administrative change**, and
 * neither can this. There is no field here that touches an account, Remote
 * Login, `sudoers` or FileVault, and there is no `enforcement_enabled` in any
 * spelling (X1). The nearest legal action is a `suspend` override, which
 * carries a mandatory expiry.
 */
export async function handlePatchSettings(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const parsed = settingsBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, "malformed settings");
  const body = parsed.data;

  const update: Record<string, unknown> = {};
  if (body.override_enabled !== undefined) update.overrideEnabled = body.override_enabled;
  if (body.override_max_minutes_per_day !== undefined) {
    update.overrideMaxMinutesPerDay = body.override_max_minutes_per_day;
  }
  if (body.override_max_grants_per_day !== undefined) {
    update.overrideMaxGrantsPerDay = body.override_max_grants_per_day;
  }
  if (body.telemetry_enabled !== undefined) update.telemetryEnabled = body.telemetry_enabled;
  if (Object.keys(update).length === 0) return fail(c, 400, "nothing to change");

  const updated = await db
    .update(policySets)
    .set(update)
    .where(and(eq(policySets.id, body.policy_set_id), eq(policySets.householdId, householdId)))
    .returning({ id: policySets.id });
  if (updated.length === 0) return fail(c, 404, "no such policy set");

  return c.json({ saved: true });
}

/** Devices that are not decommissioned — for pickers. */
export async function handleListDevices(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const rows = await db
    .select({
      id: devices.id,
      label: devices.label,
      status: devices.status,
      childId: devices.childId,
      healthState: devices.healthState,
    })
    .from(devices)
    .where(and(eq(devices.householdId, householdId), ne(devices.status, "decommissioned")));
  return c.json({ devices: rows });
}

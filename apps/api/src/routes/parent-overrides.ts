import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { children, devices, overrides, policySets } from "../db/schema.js";
import { log } from "../lib/logger.js";
import { publishPolicy } from "../policy/publish.js";
import { fail, type ParentVariables } from "./parent-context.js";

/**
 * `/override` — the 15/30/60 buttons, and the two-stage state behind them.
 *
 * ⚠️ **"Applied" is driven by the agent's own next tick**, never by this
 * handler's write. §5.8: claiming success on the write is the *"the server
 * thinks it delivered"* failure mode that polling was chosen to avoid. This
 * endpoint returns `sent`; the UI polls `/today` and flips to `applied` when
 * the device reports the new `policy_version`.
 */

/** §5.8's buttons. Anything else needs `/rules`, deliberately. */
export const QUICK_GRANT_MINUTES = [15, 30, 60] as const;

const grantBody = z.object({
  device_id: z.uuid(),
  /**
   * ⚠️ `suspend` is "No bedtime tonight" — NOT "enforcement off". It still
   * carries a mandatory `expires_at`, so it can only ever converge stricter.
   */
  type: z.enum(["extend", "suspend"]).default("extend"),
  minutes: z.int().positive().max(240).optional(),
  reason: z.string().max(200).optional(),
});

/**
 * `POST /api/parent/v1/overrides`
 *
 * ⚠️ **A.8 — `expires_at` is mandatory and computed here, never supplied.**
 * It is what makes a cached policy safe to keep enforcing indefinitely: a
 * stale policy is at worst one whose grants have all expired. A caller-chosen
 * expiry would let a UI bug write a grant that outlives the night.
 */
export async function handleGrantOverride(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const user = c.get("user");

  const parsed = grantBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, "malformed grant");
  const body = parsed.data;

  if (body.type === "extend" && !body.minutes) {
    return fail(c, 422, "an extend grant needs minutes");
  }

  const [device] = await db
    .select({
      id: devices.id,
      childId: devices.childId,
      policySetId: devices.policySetId,
      timezone: children.timezone,
      status: devices.status,
    })
    .from(devices)
    .leftJoin(children, eq(children.id, devices.childId))
    .where(and(eq(devices.id, body.device_id), eq(devices.householdId, householdId)))
    .limit(1);

  if (!device?.childId) return fail(c, 404, "no such device");
  if (device.status === "decommissioned") {
    return fail(c, 409, "this device has been decommissioned");
  }

  // ⚠️ Caps are enforced HERE as well as in the agent. §4.3: "caps are
  // enforced in the agent as well as at write time, so a server that would
  // happily issue a 6-hour grant cannot produce a UI that lies."
  // ⚠️ There is no PER-GRANT cap column — `policy_sets` has a daily minute
  // total and a daily grant count, and the CHECK constraint bounds those.
  // The daily check below therefore also bounds a single grant, which is
  // why there is no separate comparison here. Adding a per-grant column
  // would be a schema change and an A.34 question, not a handler tweak.
  const caps = device.policySetId ? await overrideCaps(device.policySetId) : null;

  const now = new Date();
  const zone = device.timezone ?? "UTC";
  const effectiveDate = localDay(now, zone);

  if (caps) {
    const used = await grantsToday(device.childId, effectiveDate);
    if (used.count >= caps.maxGrantsPerDay) {
      return fail(c, 422, `already ${used.count} grants today (cap ${caps.maxGrantsPerDay})`);
    }
    if (body.minutes && used.minutes + body.minutes > caps.maxMinutesPerDay) {
      return fail(c, 422, `that would exceed today's ${caps.maxMinutesPerDay}-minute cap`);
    }
  }

  // ★ A.8. Expire at the end of the local night the grant belongs to, so a
  // grant made at 21:45 is dead by breakfast and cannot silently apply
  // again tomorrow.
  const expiresAt = endOfNight(now, zone);

  const [created] = await db
    .insert(overrides)
    .values({
      householdId,
      childId: device.childId,
      deviceId: device.id,
      type: body.type,
      minutes: body.type === "extend" ? (body.minutes ?? null) : null,
      effectiveDate,
      expiresAt,
      grantedVia: "ui",
      grantedBy: user.id,
      reason: body.reason ?? null,
    })
    .returning({ id: overrides.id });

  if (!created) return fail(c, 409, "the grant was not recorded");

  // Recompile immediately — the grant is only real once it is in a policy
  // the agent will fetch.
  const published = await publishPolicy({
    deviceId: device.id,
    reason: "override",
    publishedBy: user.id,
  });

  log.info(
    {
      event: "override.granted",
      device_id: device.id,
      override_id: created.id,
      type: body.type,
      minutes: body.minutes ?? null,
    },
    "parent granted an override",
  );

  return c.json(
    {
      override_id: created.id,
      // ★ `sent`, not `applied`. The UI must not claim delivery.
      state: "sent",
      sent_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      // What the UI watches for to flip to `applied`.
      awaiting_policy_version: published.version,
    },
    201,
  );
}

/** `DELETE /api/parent/v1/overrides/:id` — take it back. */
export async function handleRevokeOverride(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const user = c.get("user");
  const overrideId = c.req.param("id");
  if (!overrideId) return fail(c, 400, "missing override id");

  const [row] = await db
    .select({ id: overrides.id, deviceId: overrides.deviceId })
    .from(overrides)
    .where(and(eq(overrides.id, overrideId), eq(overrides.householdId, householdId)))
    .limit(1);
  if (!row) return fail(c, 404, "no such override");

  // ⚠️ Revoked, never deleted. The audit trail is the point: "she got an
  // extra 30 minutes on Tuesday and I took it back" is a fact worth keeping.
  await db
    .update(overrides)
    .set({ revokedAt: new Date(), revokedBy: user.id })
    .where(eq(overrides.id, overrideId));

  if (row.deviceId) {
    await publishPolicy({ deviceId: row.deviceId, reason: "override", publishedBy: user.id });
  }
  return c.json({ override_id: overrideId, revoked: true });
}

/** `GET /api/parent/v1/overrides` — today's grants, live and spent. */
export async function handleListOverrides(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const rows = await db
    .select({
      id: overrides.id,
      deviceId: overrides.deviceId,
      childId: overrides.childId,
      type: overrides.type,
      minutes: overrides.minutes,
      effectiveDate: overrides.effectiveDate,
      expiresAt: overrides.expiresAt,
      revokedAt: overrides.revokedAt,
      reason: overrides.reason,
      grantedVia: overrides.grantedVia,
      createdAt: overrides.createdAt,
    })
    .from(overrides)
    .where(eq(overrides.householdId, householdId))
    .orderBy(desc(overrides.createdAt))
    .limit(100);

  const now = new Date();
  return c.json({
    overrides: rows.map((row) => ({
      id: row.id,
      device_id: row.deviceId,
      child_id: row.childId,
      type: row.type,
      minutes: row.minutes,
      effective_date: row.effectiveDate,
      expires_at: row.expiresAt.toISOString(),
      revoked_at: row.revokedAt?.toISOString() ?? null,
      reason: row.reason,
      granted_via: row.grantedVia,
      created_at: row.createdAt.toISOString(),
      live: !row.revokedAt && row.expiresAt > now,
    })),
  });
}

// ── Caps

async function overrideCaps(policySetId: string) {
  const [row] = await db
    .select({
      maxMinutesPerDay: policySets.overrideMaxMinutesPerDay,
      maxGrantsPerDay: policySets.overrideMaxGrantsPerDay,
    })
    .from(policySets)
    .where(eq(policySets.id, policySetId))
    .limit(1);
  return row ?? null;
}

async function grantsToday(childId: string, effectiveDate: string) {
  const rows = await db
    .select({ minutes: overrides.minutes })
    .from(overrides)
    .where(
      and(
        eq(overrides.childId, childId),
        eq(overrides.effectiveDate, effectiveDate),
        isNull(overrides.revokedAt),
      ),
    );
  return {
    count: rows.length,
    minutes: rows.reduce((sum, row) => sum + (row.minutes ?? 0), 0),
  };
}

// ── Local time

function localDay(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * The end of the night this grant belongs to: 06:00 local, tomorrow.
 *
 * ⚠️ Not "+N minutes". A 30-minute extension moves the boundary; it does not
 * mean the grant should evaporate 30 minutes later, half-way through the
 * evening it was granted for. And not "midnight" either — a bedtime window
 * that wraps past midnight would lose its relaxation at exactly the wrong
 * moment, which is the off-by-one-night bug `crosses_midnight` exists to
 * stop people re-deriving.
 */
export function endOfNight(at: Date, zone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");

  // Before 06:00 local, the night that is ending is TODAY's.
  const sameNight = get("hour") < 6;
  const day = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  if (!sameNight) day.setUTCDate(day.getUTCDate() + 1);

  // Resolve 06:00 in the zone by probing the offset on that date.
  const target = `${day.toISOString().slice(0, 10)}T06:00:00`;
  const guess = new Date(`${target}Z`);
  const offsetMs = zoneOffsetMs(guess, zone);
  return new Date(guess.getTime() - offsetMs);
}

function zoneOffsetMs(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUTC - at.getTime();
}

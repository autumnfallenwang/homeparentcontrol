import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  calendarExceptions,
  children,
  devices,
  policySets,
  policyVersions,
  scheduleWarnings,
  scheduleWindows,
} from "../db/schema.js";
import { log } from "../lib/logger.js";
import { compilePolicy } from "../policy/compile.js";
import { gatherCompilerInput } from "../policy/gather.js";
import { publishPolicy } from "../policy/publish.js";
import { fail, type ParentVariables } from "./parent-context.js";

/**
 * `/rules` — draft → diff → publish, and `/rules/history`.
 *
 * ⚠️ **The diff shows the COMPILED document, because that is what the agent
 * obeys.** A diff of `schedule_windows` rows would hide everything the
 * compiler does: holidays pulled live, calendar exceptions merged, live
 * grants folded in, the 21-day horizon expanded. A parent who moves bedtime
 * by 15 minutes and sees only "21:30 → 21:45" has not been shown that next
 * Monday is a public holiday and the window is suspended anyway.
 */

// ── Reading the current rules

/** `GET /api/parent/v1/rules` */
export async function handleGetRules(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");

  const sets = await db
    .select({
      id: policySets.id,
      childId: policySets.childId,
      overrideEnabled: policySets.overrideEnabled,
      overrideAllowedMinutes: policySets.overrideAllowedMinutes,
      overrideMaxMinutesPerDay: policySets.overrideMaxMinutesPerDay,
      overrideMaxGrantsPerDay: policySets.overrideMaxGrantsPerDay,
    })
    .from(policySets)
    .where(eq(policySets.householdId, householdId));

  const setIds = sets.map((set) => set.id);
  const [windows, warnings, childRows] = await Promise.all([
    setIds.length
      ? db
          .select()
          .from(scheduleWindows)
          .where(inArray(scheduleWindows.policySetId, setIds))
          .orderBy(asc(scheduleWindows.sortOrder))
      : [],
    setIds.length
      ? db
          .select()
          .from(scheduleWarnings)
          .where(
            inArray(
              scheduleWarnings.windowId,
              db
                .select({ id: scheduleWindows.id })
                .from(scheduleWindows)
                .where(inArray(scheduleWindows.policySetId, setIds)),
            ),
          )
      : [],
    db
      .select({ id: children.id, displayName: children.displayName, timezone: children.timezone })
      .from(children)
      .where(eq(children.householdId, householdId)),
  ]);

  return c.json({
    children: childRows,
    policy_sets: sets.map((set) => ({
      id: set.id,
      child_id: set.childId,
      override_enabled: set.overrideEnabled,
      override_allowed_minutes: set.overrideAllowedMinutes,
      override_caps: {
        max_minutes_per_day: set.overrideMaxMinutesPerDay,
        max_grants_per_day: set.overrideMaxGrantsPerDay,
      },
      windows: windows
        .filter((window) => window.policySetId === set.id)
        .map((window) => ({
          id: window.id,
          label: window.label,
          days: window.days,
          restricted_from: hhmm(window.restrictedFrom),
          restricted_until: hhmm(window.restrictedUntil),
          crosses_midnight: window.crossesMidnight,
          action: window.action,
          shutdown_grace_s: window.shutdownGraceS,
          escalate_after_failures: window.escalateAfterFailures,
          warnings: warnings
            .filter((warning) => warning.windowId === window.id)
            .map((warning) => ({
              lead_minutes: warning.leadMinutes,
              channel: warning.channel,
            })),
        })),
    })),
  });
}

// ── Editing

const windowBody = z.object({
  id: z.uuid().optional(),
  label: z.string().min(1).max(80),
  days: z.array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])).min(1),
  restricted_from: z.string().regex(/^\d{2}:\d{2}$/),
  restricted_until: z.string().regex(/^\d{2}:\d{2}$/),
  /**
   * ⚠️ **A.34 made structural.** `schedule_windows.action` carries the only
   * CHECK constraint in the schema, and the reason is that the vocabulary
   * itself is the boundary: nothing here may express "disable Remote Login",
   * "alter an admin account", "touch sudoers" or "change FileVault". A new
   * action is a schema migration and an ADR, not a field a client can pick.
   */
  action: z.enum(["lock", "shutdown"]).default("lock"),
  shutdown_grace_s: z.int().min(0).max(3600).default(300),
  escalate_after_failures: z.int().min(1).max(10).default(3),
  warnings: z
    .array(
      z.object({
        lead_minutes: z.int().min(1).max(120),
        channel: z.enum(["banner", "modal"]).default("banner"),
      }),
    )
    .default([]),
});

const saveBody = z.object({
  policy_set_id: z.uuid(),
  windows: z.array(windowBody),
});

/**
 * `PUT /api/parent/v1/rules` — save the draft. **Does not publish.**
 *
 * ⚠️ Saving and publishing are separate on purpose. §5.8's flow is
 * "draft → diff → publish", and the diff is only meaningful if the edit has
 * landed somewhere the compiler can read without the agent seeing it yet.
 */
export async function handleSaveRules(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const parsed = saveBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "malformed rules", issues: parsed.error.issues }, 400);
  }
  const body = parsed.data;

  const [set] = await db
    .select({ id: policySets.id })
    .from(policySets)
    .where(and(eq(policySets.id, body.policy_set_id), eq(policySets.householdId, householdId)))
    .limit(1);
  if (!set) return fail(c, 404, "no such policy set");

  for (const window of body.windows) {
    if (window.restricted_from === window.restricted_until) {
      // A zero-length window is almost certainly a typo, and it silently
      // enforces nothing. Refusing is kinder than a rule that looks set.
      return fail(c, 422, `"${window.label}" starts and ends at the same time`);
    }
  }

  await db.transaction(async (tx) => {
    // Replace wholesale: the client sends the complete set, so a window it
    // omitted was deleted. Diffing row-by-row here would need a client that
    // reports deletions, which is a second protocol to get wrong.
    const existing = await tx
      .select({ id: scheduleWindows.id })
      .from(scheduleWindows)
      .where(eq(scheduleWindows.policySetId, set.id));
    if (existing.length > 0) {
      await tx.delete(scheduleWarnings).where(
        inArray(
          scheduleWarnings.windowId,
          existing.map((row) => row.id),
        ),
      );
      await tx.delete(scheduleWindows).where(eq(scheduleWindows.policySetId, set.id));
    }

    for (const [index, window] of body.windows.entries()) {
      const [created] = await tx
        .insert(scheduleWindows)
        .values({
          householdId,
          policySetId: set.id,
          label: window.label,
          days: window.days,
          restrictedFrom: window.restricted_from,
          restrictedUntil: window.restricted_until,
          action: window.action,
          shutdownGraceS: window.shutdown_grace_s,
          escalateAfterFailures: window.escalate_after_failures,
          sortOrder: index,
        })
        .returning({ id: scheduleWindows.id });
      if (!created) continue;

      for (const warning of window.warnings) {
        await tx.insert(scheduleWarnings).values({
          householdId,
          windowId: created.id,
          leadMinutes: warning.lead_minutes,
          channel: warning.channel,
        });
      }
    }
  });

  return c.json({ saved: true, policy_set_id: set.id });
}

// ── The diff

/**
 * `GET /api/parent/v1/rules/diff?device_id=…`
 *
 * ★ Compiles the CURRENT draft without publishing it, and returns it beside
 * the document the device is actually running.
 *
 * ⚠️ **`confirm_immediate_effect` is computed here** (C3): the guard fires on
 * a **tightening that bites within 15 minutes**, and on nothing else. §4.3:
 * "Firing the guard on every +30-minute grant trains the parent to click
 * through it in exactly the case it was built for."
 */
export async function handleRulesDiff(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const deviceId = c.req.query("device_id");
  if (!deviceId) return fail(c, 400, "device_id is required");

  const [device] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.householdId, householdId)))
    .limit(1);
  if (!device) return fail(c, 404, "no such device");

  const now = new Date();
  const input = await gatherCompilerInput(deviceId, now);
  const proposed = compilePolicy(input);

  const [current] = await db
    .select({ version: policyVersions.version, document: policyVersions.document })
    .from(policyVersions)
    .where(eq(policyVersions.deviceId, deviceId))
    .orderBy(desc(policyVersions.version))
    .limit(1);

  const currentDocument = (current?.document ?? null) as Record<string, unknown> | null;
  const tightening = detectTightening(
    currentDocument,
    proposed as unknown as Record<string, unknown>,
    now,
  );

  return c.json({
    device_id: deviceId,
    current_version: current?.version ?? null,
    // ★ The compiled documents, not the rows. This is what the agent obeys.
    current_document: currentDocument,
    proposed_document: proposed,
    changed: JSON.stringify(currentDocument) !== JSON.stringify(proposed),
    // C3 — true ONLY for a tightening inside 15 minutes.
    confirm_immediate_effect: tightening.confirm,
    confirm_reason: tightening.reason,
  });
}

/** §4.3's C3 window. */
export const IMMEDIATE_EFFECT_WINDOW_MS = 15 * 60 * 1000;

interface CompiledWindow {
  id?: string;
  label?: string;
  days?: string[];
  restricted_from?: string;
  restricted_until?: string;
}

/**
 * Does the proposed document restrict something within the next 15 minutes
 * that the current one does not?
 *
 * ⚠️ **A relaxation never sets the flag**, however dramatic. The guard exists
 * for "I just moved bedtime to 19:00 and it is 18:55" — the case where a
 * parent is about to lock a child out mid-sentence without meaning to.
 */
export function detectTightening(
  current: Record<string, unknown> | null,
  proposed: Record<string, unknown>,
  now: Date,
): { confirm: boolean; reason: string | null } {
  if (!current) return { confirm: false, reason: null };

  const zone = (proposed.timezone as string) ?? "UTC";
  const currentWindows = windowsOf(current);
  const proposedWindows = windowsOf(proposed);

  for (const window of proposedWindows) {
    if (!window.restricted_from) continue;
    const startsIn = minutesUntil(window.restricted_from, now, zone);
    if (startsIn === null || startsIn < 0 || startsIn * 60_000 > IMMEDIATE_EFFECT_WINDOW_MS) {
      continue;
    }

    const before = currentWindows.find((other) => other.id === window.id);
    // A brand-new window starting within 15 minutes is a tightening.
    if (!before) {
      return {
        confirm: true,
        reason: `"${window.label ?? "A new window"}" starts in ${startsIn} minutes`,
      };
    }
    // An existing window moved EARLIER is a tightening. Later is a
    // relaxation and must not trip the guard.
    const wasIn = before.restricted_from ? minutesUntil(before.restricted_from, now, zone) : null;
    if (wasIn !== null && startsIn < wasIn) {
      return {
        confirm: true,
        reason: `"${window.label ?? "A window"}" now starts in ${startsIn} minutes, ${wasIn - startsIn} earlier than before`,
      };
    }
  }
  return { confirm: false, reason: null };
}

function windowsOf(document: Record<string, unknown>): CompiledWindow[] {
  const schedule = document.schedule as { windows?: CompiledWindow[] } | undefined;
  return schedule?.windows ?? [];
}

/** Minutes from now until the next occurrence of `HH:MM` in `zone`. */
function minutesUntil(hhmmText: string, now: Date, zone: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmmText);
  if (!match?.[1] || !match[2]) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const nowMinutes =
    Number(parts.find((p) => p.type === "hour")?.value ?? 0) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const targetMinutes = Number(match[1]) * 60 + Number(match[2]);

  const delta = targetMinutes - nowMinutes;
  return delta >= 0 ? delta : delta + 24 * 60;
}

// ── Publishing

const publishBody = z.object({
  device_id: z.uuid(),
  /** Echoed back from the diff, so a stale tab cannot publish unconfirmed. */
  confirmed_immediate_effect: z.boolean().default(false),
});

/** `POST /api/parent/v1/rules/publish` */
export async function handlePublishRules(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const user = c.get("user");
  const parsed = publishBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, "malformed publish request");

  const [device] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, parsed.data.device_id), eq(devices.householdId, householdId)))
    .limit(1);
  if (!device) return fail(c, 404, "no such device");

  // ⚠️ Re-check C3 SERVER-side at publish time, not just at diff time. The
  // parent may have left the tab open for an hour; a tightening that was 40
  // minutes away when they looked can be 4 minutes away when they click.
  const now = new Date();
  const input = await gatherCompilerInput(device.id, now);
  const proposed = compilePolicy(input);
  const [current] = await db
    .select({ document: policyVersions.document })
    .from(policyVersions)
    .where(eq(policyVersions.deviceId, device.id))
    .orderBy(desc(policyVersions.version))
    .limit(1);

  const tightening = detectTightening(
    (current?.document ?? null) as Record<string, unknown> | null,
    proposed as unknown as Record<string, unknown>,
    now,
  );
  if (tightening.confirm && !parsed.data.confirmed_immediate_effect) {
    return c.json(
      { error: "this change takes effect almost immediately", reason: tightening.reason },
      409,
    );
  }

  const result = await publishPolicy({
    deviceId: device.id,
    reason: "schedule_edit",
    publishedBy: user.id,
  });

  log.info(
    { event: "policy.published", device_id: device.id, result: result.status },
    "parent published rules",
  );
  return c.json(result);
}

// ── History and restore

/** `GET /api/parent/v1/rules/history?device_id=…` */
export async function handleRulesHistory(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const deviceId = c.req.query("device_id");
  if (!deviceId) return fail(c, 400, "device_id is required");

  const rows = await db
    .select({
      version: policyVersions.version,
      etag: policyVersions.etag,
      documentHash: policyVersions.documentHash,
      issuedAt: policyVersions.issuedAt,
      publishReason: policyVersions.publishReason,
      publishedBy: policyVersions.publishedBy,
      confirmImmediateEffect: policyVersions.confirmImmediateEffect,
    })
    .from(policyVersions)
    .where(and(eq(policyVersions.deviceId, deviceId), eq(policyVersions.householdId, householdId)))
    .orderBy(desc(policyVersions.version))
    .limit(100);

  return c.json({
    device_id: deviceId,
    versions: rows.map((row) => ({
      version: row.version,
      etag: row.etag,
      document_hash: row.documentHash,
      issued_at: row.issuedAt.toISOString(),
      reason: row.publishReason,
      published_by: row.publishedBy,
      confirm_immediate_effect: row.confirmImmediateEffect,
    })),
  });
}

/**
 * `POST /api/parent/v1/rules/history/:version/restore`
 *
 * ⚠️ **Restore publishes a NEW version with the old content; it never mutates
 * history.** §5.8 calls it "`git revert` applied to bedtime". A restore that
 * rewound `version` would make the agent's `policy_version_regression`
 * tripwire fire on a legitimate parent action, and would make "what was in
 * force on Tuesday?" unanswerable.
 *
 * ⚠️ It writes the old windows back into `schedule_windows` and then
 * recompiles, rather than re-inserting the stored document verbatim — the
 * stored document has that day's holidays and that day's grants baked in,
 * and re-publishing it would resurrect an expired grant.
 */
export async function handleRestoreVersion(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const user = c.get("user");
  const deviceId = c.req.query("device_id");
  const versionText = c.req.param("version");
  if (!deviceId || !versionText) return fail(c, 400, "device_id and version are required");

  const version = Number(versionText);
  if (!Number.isInteger(version)) return fail(c, 400, "version must be an integer");

  const [target] = await db
    .select({ document: policyVersions.document, policySetId: policyVersions.policySetId })
    .from(policyVersions)
    .where(
      and(
        eq(policyVersions.deviceId, deviceId),
        eq(policyVersions.householdId, householdId),
        eq(policyVersions.version, version),
      ),
    )
    .limit(1);
  if (!target) return fail(c, 404, "no such version");

  const document = target.document as { schedule?: { windows?: RestorableWindow[] } };
  const windows = document.schedule?.windows ?? [];
  if (windows.length === 0) return fail(c, 422, "that version has no windows to restore");

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: scheduleWindows.id })
      .from(scheduleWindows)
      .where(eq(scheduleWindows.policySetId, target.policySetId));
    if (existing.length > 0) {
      await tx.delete(scheduleWarnings).where(
        inArray(
          scheduleWarnings.windowId,
          existing.map((row) => row.id),
        ),
      );
      await tx.delete(scheduleWindows).where(eq(scheduleWindows.policySetId, target.policySetId));
    }

    for (const [index, window] of windows.entries()) {
      const [created] = await tx
        .insert(scheduleWindows)
        .values({
          householdId,
          policySetId: target.policySetId,
          label: window.label ?? "Restored window",
          days: window.days ?? [],
          restrictedFrom: window.restricted_from ?? "21:30",
          restrictedUntil: window.restricted_until ?? "07:00",
          action: window.action ?? "lock",
          shutdownGraceS: window.action_options?.shutdown_grace_s ?? 300,
          escalateAfterFailures: window.action_options?.escalate_after_failures ?? 3,
          sortOrder: index,
        })
        .returning({ id: scheduleWindows.id });
      if (!created) continue;

      for (const warning of window.warnings ?? []) {
        await tx.insert(scheduleWarnings).values({
          householdId,
          windowId: created.id,
          leadMinutes: warning.lead_minutes,
          channel: warning.channel ?? "banner",
        });
      }
    }
  });

  const result = await publishPolicy({
    deviceId,
    reason: "restore",
    publishedBy: user.id,
  });

  log.info(
    { event: "policy.restored", device_id: deviceId, from_version: version },
    "parent restored an earlier rule set",
  );
  return c.json({ restored_from: version, ...result });
}

interface RestorableWindow {
  label?: string;
  days?: string[];
  restricted_from?: string;
  restricted_until?: string;
  action?: string;
  action_options?: { shutdown_grace_s?: number; escalate_after_failures?: number };
  warnings?: { lead_minutes: number; channel?: string }[];
}

// ── Calendar exceptions

const exceptionBody = z.object({
  child_id: z.uuid(),
  /** `YYYY-MM-DD`, in the child's timezone. Column is `day`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * The schema's four effects. ⚠️ `dismiss_holiday` is how a parent says
   * "the library thinks this is a holiday and it is not one for us" — the
   * manual > dismiss > library precedence §5.6 compiles.
   */
  effect: z.enum(["treat_as_weekend", "no_bedtime", "custom", "dismiss_holiday"]),
  /** Only meaningful with `custom`. */
  extend_minutes: z.int().min(0).max(480).optional(),
  note: z.string().max(200).optional(),
});

/** `GET /api/parent/v1/rules/calendar` */
export async function handleGetCalendar(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const rows = await db
    .select()
    .from(calendarExceptions)
    .where(eq(calendarExceptions.householdId, householdId))
    .orderBy(asc(calendarExceptions.day));
  return c.json({ exceptions: rows });
}

/** `POST /api/parent/v1/rules/calendar` */
export async function handleUpsertException(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const user = c.get("user");
  const parsed = exceptionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, "malformed exception");
  const body = parsed.data;

  const [child] = await db
    .select({ id: children.id })
    .from(children)
    .where(and(eq(children.id, body.child_id), eq(children.householdId, householdId)))
    .limit(1);
  if (!child) return fail(c, 404, "no such child");

  await db
    .insert(calendarExceptions)
    .values({
      householdId,
      childId: body.child_id,
      day: body.day,
      effect: body.effect,
      extendMinutes: body.effect === "custom" ? (body.extend_minutes ?? null) : null,
      note: body.note ?? null,
      createdBy: user.id,
    })
    // ⚠️ The unique key includes `window_id`, which is NULL here — a
    // child-wide exception. Postgres treats NULLs as distinct in a unique
    // index, so this conflict target only fires for other child-wide rows,
    // which is exactly the intent: a per-window exception is a different
    // row, not an overwrite of the whole-day one.
    .onConflictDoUpdate({
      target: [calendarExceptions.childId, calendarExceptions.day, calendarExceptions.windowId],
      set: {
        effect: body.effect,
        extendMinutes: body.effect === "custom" ? (body.extend_minutes ?? null) : null,
        note: body.note ?? null,
        updatedAt: new Date(),
      },
    });

  // ⚠️ Recompile every device for this child. An exception that is not
  // compiled is a note in a table, not a rule.
  const affected = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.householdId, householdId), eq(devices.childId, body.child_id)));
  for (const device of affected) {
    await publishPolicy({ deviceId: device.id, reason: "calendar", publishedBy: user.id });
  }

  return c.json({ saved: true, recompiled: affected.length });
}

/** Postgres `time` comes back as `21:30:00`; the contract wants `HH:MM`. */
function hhmm(value: string): string {
  return value.slice(0, 5);
}

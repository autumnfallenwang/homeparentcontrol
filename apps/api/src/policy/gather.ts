import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  calendarExceptions,
  devices,
  expectedOnlineWindows,
  overrides,
  policySets,
  policyVersions,
  scheduleWindows,
} from "../db/schema.js";
import { HORIZON_DAYS } from "./compile.js";
import { getHolidays } from "./holidays.js";
import { type CompilerInput, PolicyCompileError } from "./types.js";
import { addDays, dateInZone } from "./zoned-time.js";

/**
 * The impure half: every database read and the live `date-holidays` call,
 * assembled into the bundle `compilePolicy` consumes.
 *
 * Kept separate so the compiler itself has no I/O — see `types.ts`.
 */
export async function gatherCompilerInput(deviceId: string, now: Date): Promise<CompilerInput> {
  const device = await db.query.devices.findFirst({
    where: eq(devices.id, deviceId),
    with: { child: true, household: true },
  });
  if (!device) throw new PolicyCompileError("device not found", deviceId);
  if (!device.child) throw new PolicyCompileError("device has no child", deviceId);

  // A.30 — the policy zone, resolved before anything reads a date.
  const tz = device.child.timezone ?? device.household.timezone;
  const today = dateInZone(now, tz);
  const horizonEnd = addDays(today, HORIZON_DAYS);

  // §5.6 reads `policySets[device.policySetId]`. `devices.policy_set_id` is
  // nullable while `policy_versions.policy_set_id` is NOT NULL, so fall back
  // to the child's own set before giving up — a device enrolled before anyone
  // assigned one would otherwise be uncompilable, and /enroll compiles v1
  // unconditionally.
  const policySet = device.policySetId
    ? await db.query.policySets.findFirst({ where: eq(policySets.id, device.policySetId) })
    : await db.query.policySets.findFirst({ where: eq(policySets.childId, device.childId) });
  if (!policySet) {
    throw new PolicyCompileError("device has no policy set and its child has none", deviceId);
  }

  const windows = await db.query.scheduleWindows.findMany({
    where: eq(scheduleWindows.policySetId, policySet.id),
    with: { scheduleWarnings: true },
  });

  const expectedOnline = await db
    .select({
      days: expectedOnlineWindows.days,
      fromTime: expectedOnlineWindows.fromTime,
      untilTime: expectedOnlineWindows.untilTime,
    })
    .from(expectedOnlineWindows)
    .where(eq(expectedOnlineWindows.policySetId, policySet.id));

  // Parent intent across the horizon. `child_id IS NULL` means every child.
  const exceptionRows = await db
    .select()
    .from(calendarExceptions)
    .where(
      and(
        eq(calendarExceptions.householdId, device.householdId),
        or(isNull(calendarExceptions.childId), eq(calendarExceptions.childId, device.childId)),
        sql`${calendarExceptions.day} BETWEEN ${today}::date AND ${horizonEnd}::date`,
      ),
    );

  // §5.6's predicate, plus the device filter it omits.
  //
  // ⚠️ `overrides.device_id` is nullable ("NULL = all devices") and the spec's
  // pseudocode selects `WHERE child = …` only — so a grant scoped to the
  // sibling's Mac would be compiled into this one's document. Not a
  // hypothetical: the column exists precisely to scope grants per device.
  const grantRows = await db
    .select()
    .from(overrides)
    .where(
      and(
        eq(overrides.childId, device.childId),
        isNull(overrides.revokedAt),
        gt(overrides.expiresAt, now),
        or(isNull(overrides.deviceId), eq(overrides.deviceId, deviceId)),
      ),
    );

  const [latest] = await db
    .select({ version: policyVersions.version })
    .from(policyVersions)
    .where(eq(policyVersions.deviceId, deviceId))
    .orderBy(desc(policyVersions.version))
    .limit(1);

  const holidays = device.household.holidaysEnabled
    ? getHolidays(device.household.holidayCountries ?? [], today, horizonEnd)
    : [];

  return {
    now,
    device: { id: device.id },
    child: {
      id: device.child.id,
      displayName: device.child.displayName,
      timezone: device.child.timezone,
    },
    household: { id: device.householdId, timezone: device.household.timezone },
    policySet: {
      id: policySet.id,
      agentLogLevel: policySet.agentLogLevel,
      diagnosticsRetentionDays: policySet.diagnosticsRetentionDays,
      pollBaseIntervalS: policySet.pollBaseIntervalS,
      pollBoundaryIntervalS: policySet.pollBoundaryIntervalS,
      pollBoundaryLeadS: policySet.pollBoundaryLeadS,
      overrideEnabled: policySet.overrideEnabled,
      overrideAllowedMinutes: policySet.overrideAllowedMinutes,
      overrideMaxMinutesPerDay: policySet.overrideMaxMinutesPerDay,
      overrideMaxGrantsPerDay: policySet.overrideMaxGrantsPerDay,
      telemetryEnabled: policySet.telemetryEnabled,
      telemetrySampleIntervalS: policySet.telemetrySampleIntervalS,
      telemetryFlushIntervalS: policySet.telemetryFlushIntervalS,
      telemetryCollect: policySet.telemetryCollect,
      telemetryMaxQueueEvents: policySet.telemetryMaxQueueEvents,
      telemetryMaxQueueBytes: policySet.telemetryMaxQueueBytes,
      telemetryMaxQueueAgeDays: policySet.telemetryMaxQueueAgeDays,
      telemetryAuditRetentionDays: policySet.telemetryAuditRetentionDays,
      stalenessWarnAfterS: policySet.stalenessWarnAfterS,
    },
    windows: windows.map((w) => ({
      id: w.id,
      label: w.label,
      days: w.days,
      restrictedFrom: w.restrictedFrom,
      restrictedUntil: w.restrictedUntil,
      // The generated column. Never re-derived here — that is the point of it.
      crossesMidnight: w.crossesMidnight ?? false,
      action: w.action,
      shutdownGraceS: w.shutdownGraceS,
      escalateAfterFailures: w.escalateAfterFailures,
      sortOrder: w.sortOrder,
      warnings: w.scheduleWarnings.map((warning) => ({
        leadMinutes: warning.leadMinutes,
        channel: warning.channel,
      })),
    })),
    expectedOnline,
    exceptions: exceptionRows.map((e) => ({
      id: e.id,
      day: e.day,
      effect: e.effect,
      extendMinutes: e.extendMinutes,
      windowId: e.windowId,
      note: e.note,
    })),
    grants: grantRows.map((g) => ({
      id: g.id,
      type: g.type,
      windowId: g.windowId,
      minutes: g.minutes,
      effectiveDate: g.effectiveDate,
      expiresAt: g.expiresAt,
      grantedBy: g.grantedBy,
      grantedVia: g.grantedVia,
      reason: g.reason,
    })),
    holidays,
    nextVersion: (latest?.version ?? 0) + 1,
  };
}

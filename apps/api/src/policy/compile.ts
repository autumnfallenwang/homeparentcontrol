import { policyDocument } from "@hpc/contract";
import { deterministicUuid } from "./canonical.js";
import type { CompilerInput, ExceptionInput, PolicyDocument, WindowInput } from "./types.js";
import { addDays, dateInZone, WEEKDAYS, weekdayOf, zonedToInstant } from "./zoned-time.js";

/**
 * The policy compiler (§5.6) — a pure function of authoring state plus one
 * clock argument. No database, no library call, no secret. Everything impure
 * happens in `gather.ts`; see `types.ts` for why the boundary sits there.
 */

/**
 * ⚖️ "A guess, and easy to change — it is one constant, not a schema
 * decision" (§5.6). Exceptions and holidays are sent this far ahead; a device
 * offline longer than this falls back to the baseline schedule, which is A.8's
 * converge-stricter property showing up as a product behaviour.
 */
export const HORIZON_DAYS = 21;

/**
 * An override on its way into the document. Deliberately looser than the
 * contract's parsed shape: `type` and `granted_via` arrive from `text` columns
 * and are narrowed by `policyDocument.parse` at the end, where the CHECK
 * constraints on those columns are the real guard.
 */
interface OverrideDraft {
  id: string;
  type: string;
  window_id: string | null;
  minutes: number | null;
  effective_date: string;
  expires_at: string;
  granted_by: string | null;
  granted_via: string;
  reason: string | null;
}

/**
 * `"21:30:00"` → `"21:30"`.
 *
 * ⚠️ Postgres `time` columns come back with seconds, and the contract's
 * `timeOfDay` is strictly `HH:MM` ("never an instant"). Golden fixtures are
 * hand-written as `HH:MM`, so nothing but a live database exposes this —
 * `publish.integration.test.ts` is what caught it. Normalising here rather
 * than in `gather` keeps the guarantee at the one place that promises a
 * contract-conformant document.
 */
function toHhMm(time: string): string {
  return time.slice(0, 5);
}

/** `"21:30"` → minutes since local midnight. */
function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h as number) * 60 + (m as number);
}

/** Canonical `mon…sun`. Unrecognised values are dropped, not passed through. */
function canonicalDays(days: string[]): string[] {
  const present = new Set(days);
  return WEEKDAYS.filter((d) => present.has(d));
}

/** Does this window's evening fall on that date? */
function appliesOn(window: WindowInput, date: string): boolean {
  return window.days.includes(weekdayOf(date));
}

/**
 * When a relaxation of `window` on `date` must end: the window's own
 * `restricted_until`, on the following day if it wraps past midnight.
 *
 * ⚠️ Reads the `crosses_midnight` generated column rather than re-deriving the
 * wrap rule. §5.2: "Three re-derivations is how an off-by-one-night bug ships."
 */
function windowEnd(window: WindowInput, date: string, tz: string): Date {
  const endDate = window.crossesMidnight ? addDays(date, 1) : date;
  return zonedToInstant(endDate, window.restrictedUntil, tz);
}

/** Local midnight ending `date` — the expiry for a whole-day relaxation. */
function endOfDay(date: string, tz: string): Date {
  return zonedToInstant(addDays(date, 1), "00:00", tz);
}

/** How long the window restricts for, in minutes, wrap included. */
function windowDuration(window: WindowInput): number {
  const from = toMinutes(window.restrictedFrom);
  const until = toMinutes(window.restrictedUntil);
  return window.crossesMidnight ? 1440 - from + until : until - from;
}

/**
 * The window a `treat_as_weekend` exception borrows its bedtime from: the one
 * covering Saturday or Sunday. With several, the most permissive (latest
 * start) wins — "treat this like a weekend" should not land on the stricter of
 * two weekend rules.
 */
function weekendWindow(windows: WindowInput[]): WindowInput | undefined {
  const candidates = windows.filter((w) => w.days.includes("sat") || w.days.includes("sun"));
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, w) =>
    toMinutes(w.restrictedFrom) > toMinutes(best.restrictedFrom) ? w : best,
  );
}

/**
 * §5.6's holiday insight: "a holiday is not a new kind of rule. It is a
 * relaxation of a known window, for a known date, that must end — which is the
 * exact definition of an override."
 *
 * The spec gives the mapping (`treat_as_weekend → extend`, `no_bedtime →
 * suspend`, `custom → extend`) and stops. The arithmetic below — how many
 * minutes, expiring when, with which id — is designed, not transcribed.
 *
 * ⚠️ Synthesised in memory, never written as `overrides` rows. The table
 * carries `source_exception_id` and `granted_via='calendar'`, which reads like
 * the opposite intent; doing both would count every holiday twice, including
 * against `override_policy.max_minutes_per_day`.
 */
function synthesise(input: CompilerInput, tz: string, today: string): OverrideDraft[] {
  const horizonEnd = addDays(today, HORIZON_DAYS);
  const inHorizon = (date: string) => date >= today && date <= horizonEnd;

  const exceptions = input.exceptions.filter((e) => inHorizon(e.day));
  const dismissed = new Set(
    exceptions.filter((e) => e.effect === "dismiss_holiday").map((e) => e.day),
  );
  const manualDates = new Set(
    exceptions.filter((e) => e.effect !== "dismiss_holiday").map((e) => e.day),
  );

  const out: OverrideDraft[] = [];

  // Parent intent first. §5.6's precedence is `manual > dismiss > library`.
  for (const exception of exceptions) {
    if (exception.effect === "dismiss_holiday") continue; // suppresses, emits nothing
    out.push(...fromException(exception, input, tz));
  }

  // Then the library, for dates the parent has not spoken about.
  for (const holiday of input.holidays) {
    if (!inHorizon(holiday.date)) continue;
    if (manualDates.has(holiday.date) || dismissed.has(holiday.date)) continue;
    out.push(
      ...treatAsWeekend({
        date: holiday.date,
        windows: input.windows,
        tz,
        reason: `calendar: ${holiday.name}`,
        idParts: ["holiday", input.child.id, holiday.date],
      }),
    );
  }

  return out;
}

function fromException(
  exception: ExceptionInput,
  input: CompilerInput,
  tz: string,
): OverrideDraft[] {
  const { day, windowId } = exception;
  const reason = exception.note ?? `calendar: ${exception.effect}`;
  const target = windowId ? input.windows.find((w) => w.id === windowId) : undefined;

  switch (exception.effect) {
    case "no_bedtime":
      // A single suspend. `window_id: null` already means "every window", so
      // there is nothing to fan out.
      return [
        {
          id: deterministicUuid("exception", exception.id, windowId ?? "all", day),
          type: "suspend",
          window_id: windowId,
          minutes: null,
          effective_date: day,
          expires_at: (target ? windowEnd(target, day, tz) : endOfDay(day, tz)).toISOString(),
          granted_by: null,
          granted_via: "calendar",
          reason,
        },
      ];

    case "custom":
      // The minutes are explicit, so one entry covers every window.
      if (!exception.extendMinutes || exception.extendMinutes <= 0) return [];
      return [
        {
          id: deterministicUuid("exception", exception.id, windowId ?? "all", day),
          type: "extend",
          window_id: windowId,
          minutes: exception.extendMinutes,
          effective_date: day,
          expires_at: (target ? windowEnd(target, day, tz) : endOfDay(day, tz)).toISOString(),
          granted_by: null,
          granted_via: "calendar",
          reason,
        },
      ];

    case "treat_as_weekend":
      // Fans out: the minute delta differs per window, so this cannot be one
      // entry with a null window_id.
      return treatAsWeekend({
        date: day,
        windows: target ? [target] : input.windows,
        tz,
        reason,
        idParts: ["exception", exception.id],
      });

    default:
      // An effect the DB CHECK permits but this compiler does not know. Emit
      // nothing: a relaxation we cannot compute is a relaxation we must not
      // guess at.
      return [];
  }
}

/**
 * "Treat this day like a weekend" expressed as the only thing the wire can
 * carry: an `extend` by the gap between this window's bedtime and the
 * weekend's.
 *
 * ⚠️ Emits NOTHING when there is no weekend window, or when the delta is not
 * positive. Overrides are relaxations only (§5.6: "What a calendar exception
 * cannot do: make bedtime earlier"), so the safe failure is no relaxation at
 * all rather than a guess.
 */
function treatAsWeekend(args: {
  date: string;
  windows: WindowInput[];
  tz: string;
  reason: string;
  idParts: string[];
}): OverrideDraft[] {
  const weekend = weekendWindow(args.windows);
  if (!weekend) return [];
  const weekendStart = toMinutes(weekend.restrictedFrom);

  const out: OverrideDraft[] = [];
  for (const window of args.windows) {
    if (!appliesOn(window, args.date)) continue;
    const delta = weekendStart - toMinutes(window.restrictedFrom);
    if (delta <= 0) continue; // already at or past weekend bedtime

    // ⚠️ Clamped to the window's own length. Borrowing the weekend's start
    // time only makes sense for another bedtime window; applied to, say,
    // 13:00–15:00 quiet hours it yields a 9½-hour "extension" that runs far
    // past the rule it is relaxing. At the cap the window collapses to
    // nothing, which is exactly what "today does not count" should mean, and
    // the number can never exceed the rule it modifies. Surfaced by the
    // `non-wrapping-window` golden.
    const minutes = Math.min(delta, windowDuration(window));
    out.push({
      id: deterministicUuid(...args.idParts, window.id, args.date),
      type: "extend",
      window_id: window.id,
      minutes,
      effective_date: args.date,
      expires_at: windowEnd(window, args.date, args.tz).toISOString(),
      granted_by: null,
      granted_via: "calendar",
      reason: args.reason,
    });
  }
  return out;
}

/**
 * Compile one device's policy document.
 *
 * A.17 — policy is authored per child and compiled per device, so two Macs on
 * one policy set produce two documents differing only in `device_id`.
 */
export function compilePolicy(input: CompilerInput): PolicyDocument {
  // A.30 — the IANA zone from policy wins; the system zone is never an input.
  const tz = input.child.timezone ?? input.household.timezone;
  const today = dateInZone(input.now, tz);
  const issuedAt = input.now.toISOString();

  // Deterministic order, everywhere. Unspecified in the spec, and without it
  // the content hash is unstable and "no change, no new version" evaporates.
  const windows = [...input.windows]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map((w) => ({
      id: w.id,
      label: w.label,
      days: canonicalDays(w.days),
      restricted_from: toHhMm(w.restrictedFrom),
      restricted_until: toHhMm(w.restrictedUntil),
      action: w.action,
      action_options: {
        shutdown_grace_s: w.shutdownGraceS,
        escalate_after_failures: w.escalateAfterFailures,
      },
      warnings: [...w.warnings]
        .sort((a, b) => b.leadMinutes - a.leadMinutes)
        .map((warning) => ({ lead_minutes: warning.leadMinutes, channel: warning.channel })),
    }));

  const granted: OverrideDraft[] = input.grants.map((g) => ({
    id: g.id,
    type: g.type,
    window_id: g.windowId,
    minutes: g.minutes,
    effective_date: g.effectiveDate,
    expires_at: g.expiresAt.toISOString(),
    granted_by: g.grantedBy,
    granted_via: g.grantedVia,
    reason: g.reason,
  }));

  const overrides = [...granted, ...synthesise(input, tz, today)]
    // Every relaxation must still be live. Grants are already filtered by
    // `gather`; a synthesised one for earlier today may have passed.
    .filter((o) => new Date(o.expires_at) > input.now)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.id.localeCompare(b.id));

  const expectedOnline = [...input.expectedOnline]
    .map((w) => ({
      days: canonicalDays(w.days),
      from: toHhMm(w.fromTime),
      until: toHhMm(w.untilTime),
    }))
    .sort(
      (a, b) =>
        WEEKDAYS.indexOf(a.days[0] as (typeof WEEKDAYS)[number]) -
          WEEKDAYS.indexOf(b.days[0] as (typeof WEEKDAYS)[number]) || a.from.localeCompare(b.from),
    );

  const set = input.policySet;

  // Parsed rather than cast, so the output is contract-conformant by
  // construction and defaults are applied consistently — two documents with
  // the same content cannot differ by an absent-vs-defaulted field.
  //
  // ⚠️ No `fail_mode`: X11 removed it and the contract has no such key, so it
  // would be stripped here even if something upstream tried to set it.
  return policyDocument.parse({
    policy_version: input.nextVersion,
    issued_at: issuedAt,
    not_before: issuedAt,
    device_id: input.device.id,
    subject: { child_id: input.child.id, display_name: input.child.displayName },

    timezone: tz,
    // ⚠️ Always false for now. "A tightening that bites within 15 minutes"
    // needs a diff against the previous version plus a second, server-side
    // DST-correct boundary resolver — neither specified nor scheduled — and
    // the agent's tick never reads this field. It lands with the /rules
    // publish screen that actually shows the confirmation (milestone 02).
    confirm_immediate_effect: false,

    poll: {
      base_interval_s: set.pollBaseIntervalS,
      boundary_interval_s: set.pollBoundaryIntervalS,
      boundary_lead_s: set.pollBoundaryLeadS,
    },
    agent: {
      log_level: set.agentLogLevel,
      diagnostics_retention_days: set.diagnosticsRetentionDays,
    },

    schedule: { kind: "windows", windows },
    overrides,
    override_policy: {
      enabled: set.overrideEnabled,
      allowed_minutes: set.overrideAllowedMinutes,
      max_minutes_per_day: set.overrideMaxMinutesPerDay,
      max_grants_per_day: set.overrideMaxGrantsPerDay,
    },
    expected_online: expectedOnline,
    telemetry: {
      enabled: set.telemetryEnabled,
      sample_interval_s: set.telemetrySampleIntervalS,
      flush_interval_s: set.telemetryFlushIntervalS,
      collect: set.telemetryCollect,
      max_queue_events: set.telemetryMaxQueueEvents,
      max_queue_bytes: set.telemetryMaxQueueBytes,
      max_queue_age_days: set.telemetryMaxQueueAgeDays,
      audit_retention_days: set.telemetryAuditRetentionDays,
    },
    // X1c — warn only. There is no `max_age_s` and there must not be.
    staleness: { warn_after_s: set.stalenessWarnAfterS },
  });
}

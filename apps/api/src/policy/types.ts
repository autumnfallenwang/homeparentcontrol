import type { PolicyDocument } from "@hpc/contract";

/**
 * The compiler's input bundle — everything `compilePolicy` is allowed to see.
 *
 * ⚠️ This type IS the purity boundary. §5.6 calls the compiler "a pure function
 * of authoring state plus the date … with no database and no clock injection
 * beyond one argument", then gives it a body that calls a live holiday service,
 * reads the current version and INSERTs. The split is not described anywhere;
 * this is it. Everything impure happens in `gather.ts` and lands here as data.
 *
 * Holidays in particular arrive PRE-RESOLVED. Calling `date-holidays` inside the
 * compiler would make every golden file rot on a library bump or a year
 * rollover, which is exactly the trap the "pure function" claim walks into.
 */
export interface CompilerInput {
  /** The one clock argument. Nothing else in the compiler may read the time. */
  now: Date;
  device: { id: string };
  child: { id: string; displayName: string; timezone: string | null };
  /** `id` is the tenancy key; the compiler never reads it, `publish` does. */
  household: { id: string; timezone: string };
  policySet: PolicySetInput;
  windows: WindowInput[];
  expectedOnline: ExpectedOnlineInput[];
  /** Parent INTENT rows only, already clipped to the horizon. */
  exceptions: ExceptionInput[];
  /**
   * Already filtered by `gather` to: this child, not revoked, not expired, and
   * this device or device-wide. ⚠️ §5.6's predicate omits the device filter, so
   * a grant scoped to another Mac would leak in — see `gather.ts`.
   */
  grants: GrantInput[];
  /** Pre-resolved public holidays across the horizon. Empty when disabled. */
  holidays: HolidayHit[];
  /** Monotonic per device. `gather` reads `max(version) + 1`. */
  nextVersion: number;
}

export interface PolicySetInput {
  id: string;
  agentLogLevel: string;
  diagnosticsRetentionDays: number;
  pollBaseIntervalS: number;
  pollBoundaryIntervalS: number;
  pollBoundaryLeadS: number;
  overrideEnabled: boolean;
  overrideAllowedMinutes: number[];
  overrideMaxMinutesPerDay: number;
  overrideMaxGrantsPerDay: number;
  telemetryEnabled: boolean;
  telemetrySampleIntervalS: number;
  telemetryFlushIntervalS: number;
  telemetryCollect: string[];
  telemetryMaxQueueEvents: number;
  telemetryMaxQueueBytes: number;
  telemetryMaxQueueAgeDays: number;
  telemetryAuditRetentionDays: number;
  stalenessWarnAfterS: number;
}

export interface WindowInput {
  id: string;
  label: string;
  days: string[];
  restrictedFrom: string;
  restrictedUntil: string;
  /**
   * The generated column, never re-derived. §5.2: "Derived ONCE so the UI, the
   * compiler and the validator cannot each re-derive the wrap rule slightly
   * differently. Three re-derivations is how an off-by-one-night bug ships."
   */
  crossesMidnight: boolean;
  action: string;
  shutdownGraceS: number;
  escalateAfterFailures: number;
  sortOrder: number;
  warnings: Array<{ leadMinutes: number; channel: string }>;
}

export interface ExpectedOnlineInput {
  days: string[];
  fromTime: string;
  untilTime: string;
}

export interface ExceptionInput {
  id: string;
  /** NULL means every child in the household. `gather` resolves that. */
  day: string;
  effect: string;
  extendMinutes: number | null;
  /** NULL means every window. */
  windowId: string | null;
  /** Becomes the override's `reason` — §5.6's "+60 min, calendar: Christmas Day". */
  note: string | null;
}

export interface GrantInput {
  id: string;
  type: string;
  windowId: string | null;
  minutes: number | null;
  effectiveDate: string;
  expiresAt: Date;
  grantedBy: string | null;
  grantedVia: string;
  reason: string | null;
}

/** One public holiday on one date, already merged across countries. */
export interface HolidayHit {
  /** `YYYY-MM-DD`, local to the policy timezone. */
  date: string;
  name: string;
}

export type PublishReason = "schedule_edit" | "override" | "calendar" | "restore" | "enrol";

export type PublishResult =
  | { status: "unchanged"; version: number; etag: string }
  | { status: "published"; version: number; etag: string; contentHash: string };

/** Thrown when authoring state cannot produce a document at all. */
export class PolicyCompileError extends Error {
  constructor(
    message: string,
    readonly deviceId: string,
  ) {
    super(message);
    this.name = "PolicyCompileError";
  }
}

export type { PolicyDocument };

import { and, desc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices, enforcementLog, policyVersions } from "../db/schema.js";

/**
 * "What actually happened", as a parent reads it.
 *
 * `enforcement_log` holds one row per agent event, in the agent's own terms:
 * a bedtime shutdown is "Enforced: shutdown" plus "Agent stopped cleanly"
 * TWICE (the enforcer and sync each say it), and every rule change is
 * "Applied policy version N". Accurate, and unreadable. This turns those rows
 * into the handful of lines a parent actually wants, at READ time — so
 * history projected before this existed reads the same way, with no backfill.
 *
 * ⚠️ **"Turned on" comes from the server's own `power_on` rows** (see
 * `recordPowerOn` in `routes/sync.ts`: the Mac's uptime dropped between two
 * check-ins). NOT from the agent's `boot_id`: each daemon invents that per
 * PROCESS, and events spooled before a shutdown are stamped with the next
 * process's id when drained — trusting it produced a "turned on" BEFORE the
 * shutdown it followed, on real data (2026-09-28).
 *
 * One inference is kept, for history recorded before `power_on` rows existed:
 * after a shutdown the ENFORCER itself ordered at bedtime, the next launch is
 * the boot. A stop with no enforced shutdown and no `power_on` after it is
 * never called a power cycle — it may have been an install or an upgrade.
 */

export type HistoryTone = "alarm" | "plain";

export interface HistoryRow {
  at: string;
  kind: string;
  summary: string;
  deviceId: string;
  policyVersion: number | null;
  /** ★ `alarm` rows are drawn red: the Mac turning on or off. */
  tone: HistoryTone;
}

/** One `enforcement_log` row. */
export interface RawHistoryRow {
  deviceId: string;
  kind: string;
  summary: string;
  occurredAt: Date;
  policyVersion: number | null;
  detail: unknown;
}

/** What was true for a device just before the rows being presented. */
export interface DeviceContext {
  /** Whether the device has ANY history before the window. */
  hasHistoryBefore: boolean;
  /** The last policy version it applied before the window. */
  versionBefore: number | null;
  /** A removed device's last stop is its uninstall, not a shutdown. */
  removed: boolean;
}

/** Why a policy version was made — `policy_versions.publish_reason`, and whether a parent did it. */
export interface PolicyReason {
  reason: string;
  byParent: boolean;
}

export const HISTORY_TEXT = {
  turnedOn: "Mac turned on",
  shutDown: "Mac shut down",
  shutDownAtBedtime: "Mac shut down at bedtime",
  started: "Parental controls started",
  restarted: "Parental controls restarted",
  stopped: "Parental controls stopped",
  removed: "Parental controls removed",
  registered: "Mac registered",
  rules: {
    enrol: "Mac got its first rules",
    schedule_edit: "Mac got your new rules",
    restore: "Mac got your restored rules",
    override: "Mac got the extra-time change",
    calendar: "Mac got the calendar change",
    other: "Mac got updated rules",
  },
} as const;

/** Rows of one stop within this long of each other are one stop. */
const STOP_EPISODE_MS = 120_000;
/** The enforcer's launch this soon after a power-on is that boot, not news. */
const BOOT_LAUNCH_MS = 15 * 60_000;

const EMPTY_CONTEXT: DeviceContext = {
  hasHistoryBefore: false,
  versionBefore: null,
  removed: false,
};

function action(row: RawHistoryRow): string | null {
  const value = (row.detail as Record<string, unknown> | null)?.action;
  return typeof value === "string" ? value : null;
}

function isStopPart(row: RawHistoryRow): boolean {
  return (
    row.kind === "agent_stopping" || (row.kind === "action_taken" && action(row) === "shutdown")
  );
}

/** The sync daemon's one-off start at enrolment, as opposed to the enforcer's launch. */
function isEnrolmentStart(row: RawHistoryRow): boolean {
  return (row.detail as Record<string, unknown> | null)?.enrolled === true;
}

/** A presented row, plus where in the raw story it happened (for ties). */
type Sequenced = HistoryRow & { seq: number };

/**
 * Present raw rows, ASCENDING by time, as the parent's history, NEWEST first.
 * Pure, so every rule below has a test that does not need a database.
 */
export function presentHistory(
  rows: RawHistoryRow[],
  contexts: Map<string, DeviceContext> = new Map(),
  reasons: Map<string, PolicyReason> = new Map(),
): HistoryRow[] {
  const byDevice = new Map<string, RawHistoryRow[]>();
  for (const row of rows) {
    const list = byDevice.get(row.deviceId) ?? [];
    list.push(row);
    byDevice.set(row.deviceId, list);
  }

  const out: Sequenced[] = [];
  for (const [deviceId, list] of byDevice) {
    out.push(...presentDevice(deviceId, list, contexts.get(deviceId) ?? EMPTY_CONTEXT, reasons));
  }
  // Newest first; within one instant, the row that came LATER in the story
  // first — so a lock and the shutdown in the same second read "locked, then
  // shut down".
  return out
    .sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq)
    .map(({ seq: _seq, ...row }) => row);
}

function presentDevice(
  deviceId: string,
  rows: RawHistoryRow[],
  context: DeviceContext,
  reasons: Map<string, PolicyReason>,
): Sequenced[] {
  const out: Sequenced[] = [];
  let seq = 0;
  let seenAny = context.hasHistoryBefore;
  let lastVersion = context.versionBefore;
  let lastPowerOn: Date | null = null;
  let stop: { at: Date; lastAt: Date; lastSeq: number; bedtime: boolean } | null = null;

  const push = (
    at: Date,
    kind: string,
    summary: string,
    tone: HistoryTone,
    rowSeq = seq,
    policyVersion: number | null = null,
  ) =>
    out.push({ at: at.toISOString(), kind, summary, deviceId, policyVersion, tone, seq: rowSeq });

  /** The Mac went off: at the stop's start, sorted after anything else in it. */
  const shutDown = () => {
    if (!stop) return;
    const text = stop.bedtime ? HISTORY_TEXT.shutDownAtBedtime : HISTORY_TEXT.shutDown;
    push(stop.at, "power_off", text, "alarm", stop.lastSeq);
    stop = null;
  };

  /** A stop nothing has explained yet — a bedtime shutdown is still known to be one. */
  const unexplainedStop = () => {
    if (!stop) return;
    if (stop.bedtime) return shutDown();
    push(stop.at, "agent_stopped", HISTORY_TEXT.stopped, "plain", stop.lastSeq);
    stop = null;
  };

  for (const row of rows) {
    seq++;

    // ── Collect the pair of `agent_stopping` rows and any enforced shutdown
    // around them into ONE stop; what it was is decided by what comes next.
    if (isStopPart(row)) {
      if (stop && row.occurredAt.getTime() - stop.lastAt.getTime() > STOP_EPISODE_MS) {
        unexplainedStop();
      }
      if (!stop)
        stop = { at: row.occurredAt, lastAt: row.occurredAt, lastSeq: seq, bedtime: false };
      stop.lastAt = row.occurredAt;
      stop.lastSeq = seq;
      if (action(row) === "shutdown") stop.bedtime = true;
      seenAny = true;
      continue;
    }

    if (row.kind === "power_on") {
      // The server saw the uptime drop: whatever stop came before WAS the shutdown.
      shutDown();
      push(row.occurredAt, "power_on", HISTORY_TEXT.turnedOn, "alarm");
      lastPowerOn = row.occurredAt;
      seenAny = true;
      continue;
    }

    if (row.kind === "agent_started") {
      if (isEnrolmentStart(row)) {
        push(row.occurredAt, "registered", HISTORY_TEXT.registered, "plain");
      } else if (
        lastPowerOn !== null &&
        row.occurredAt.getTime() - lastPowerOn.getTime() <= BOOT_LAUNCH_MS
      ) {
        // The enforcer launching at that boot — the power-on line already says it.
        lastPowerOn = null;
      } else if (stop?.bedtime) {
        // History from before `power_on` rows: the enforcer shut the Mac down,
        // so its next launch is the Mac coming back on.
        shutDown();
        push(row.occurredAt, "power_on", HISTORY_TEXT.turnedOn, "alarm");
      } else if (stop) {
        // Stopped and started with no power-on between: an install, an
        // upgrade, or launchd restarting it.
        stop = null;
        push(row.occurredAt, "agent_restarted", HISTORY_TEXT.restarted, "plain");
      } else {
        const kind = seenAny ? "agent_restarted" : "agent_started";
        push(
          row.occurredAt,
          kind,
          seenAny ? HISTORY_TEXT.restarted : HISTORY_TEXT.started,
          "plain",
        );
      }
      seenAny = true;
      continue;
    }

    if (row.kind === "policy_applied") {
      seenAny = true;
      const version = row.policyVersion;
      // The same version again is the agent re-applying what it already had
      // after a restart. Nothing reached the Mac.
      if (version !== null && version === lastVersion) continue;
      lastVersion = version ?? lastVersion;
      const why = version === null ? undefined : reasons.get(`${deviceId}:${version}`);
      // The nightly top-up of the schedule horizon: nothing changed for the parent.
      if (why?.reason === "calendar" && !why.byParent) continue;
      push(row.occurredAt, "policy_applied", rulesText(why), "plain", seq, version);
      continue;
    }

    push(row.occurredAt, row.kind, row.summary, "plain", seq, row.policyVersion);
    seenAny = true;
  }

  // A stop with nothing after it: a removed device's uninstall, a Mac still
  // off after a bedtime shutdown, or a stop nothing has explained yet.
  if (stop) {
    const pending: { at: Date; lastSeq: number } = stop;
    if (context.removed) {
      push(pending.at, "agent_removed", HISTORY_TEXT.removed, "plain", pending.lastSeq);
      stop = null;
    } else {
      unexplainedStop();
    }
  }
  return out;
}

function rulesText(why: PolicyReason | undefined): string {
  switch (why?.reason) {
    case "enrol":
      return HISTORY_TEXT.rules.enrol;
    case "schedule_edit":
      return HISTORY_TEXT.rules.schedule_edit;
    case "restore":
      return HISTORY_TEXT.rules.restore;
    case "override":
      return HISTORY_TEXT.rules.override;
    case "calendar":
      return HISTORY_TEXT.rules.calendar;
    default:
      return HISTORY_TEXT.rules.other;
  }
}

// ── Loading

export interface HistoryRequest {
  householdId: string;
  childId?: string;
  deviceId?: string;
  from: Date;
  /** Exclusive. Omitted means "up to whatever the agent's clock said". */
  to?: Date;
  /** Raw rows read at most. Past it the list and the counts are floors. */
  limit?: number;
}

export interface HistoryResult {
  rows: HistoryRow[];
  /** "Mac turned on", counted in the window. */
  startups: number;
  /** True when more raw rows existed than were read — the counts are floors. */
  truncated: boolean;
}

const DEFAULT_LIMIT = 5_000;

/** The raw rows, newest first. */
function rawRows(where: SQL | undefined, limit: number) {
  return db
    .select({
      deviceId: enforcementLog.deviceId,
      kind: enforcementLog.kind,
      summary: enforcementLog.summary,
      occurredAt: enforcementLog.occurredAt,
      policyVersion: enforcementLog.policyVersion,
      detail: enforcementLog.detail,
    })
    .from(enforcementLog)
    .where(where)
    .orderBy(desc(enforcementLog.occurredAt))
    .limit(limit);
}

export async function loadHistory(request: HistoryRequest): Promise<HistoryResult> {
  const limit = request.limit ?? DEFAULT_LIMIT;
  const scope = [
    eq(enforcementLog.householdId, request.householdId),
    gte(enforcementLog.occurredAt, request.from),
  ];
  if (request.to) scope.push(lt(enforcementLog.occurredAt, request.to));
  if (request.childId) scope.push(eq(enforcementLog.childId, request.childId));
  if (request.deviceId) scope.push(eq(enforcementLog.deviceId, request.deviceId));

  const fetched = await rawRows(and(...scope), limit + 1);
  const truncated = fetched.length > limit;
  const rows = fetched.slice(0, limit).reverse();

  const deviceIds = [...new Set(rows.map((row) => row.deviceId))];
  const contexts = new Map<string, DeviceContext>();
  const reasons = new Map<string, PolicyReason>();

  if (deviceIds.length > 0) {
    const statuses = await db
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(inArray(devices.id, deviceIds));

    await Promise.all(
      deviceIds.map(async (deviceId) => {
        const earliest = rows.find((row) => row.deviceId === deviceId)?.occurredAt ?? request.from;
        const before = and(
          eq(enforcementLog.deviceId, deviceId),
          lt(enforcementLog.occurredAt, earliest),
        );
        const [previous] = await rawRows(before, 1);
        const [applied] = await db
          .select({ version: enforcementLog.policyVersion })
          .from(enforcementLog)
          .where(and(before, eq(enforcementLog.kind, "policy_applied")))
          .orderBy(desc(enforcementLog.occurredAt))
          .limit(1);
        contexts.set(deviceId, {
          hasHistoryBefore: previous !== undefined,
          versionBefore: applied?.version ?? null,
          removed: statuses.find((row) => row.id === deviceId)?.status === "decommissioned",
        });
      }),
    );

    const versions = [
      ...new Set(rows.map((row) => row.policyVersion).filter((v): v is number => v !== null)),
    ];
    if (versions.length > 0) {
      const made = await db
        .select({
          deviceId: policyVersions.deviceId,
          version: policyVersions.version,
          reason: policyVersions.publishReason,
          publishedBy: policyVersions.publishedBy,
        })
        .from(policyVersions)
        .where(
          and(
            inArray(policyVersions.deviceId, deviceIds),
            inArray(policyVersions.version, versions),
          ),
        );
      for (const row of made) {
        reasons.set(`${row.deviceId}:${row.version}`, {
          reason: row.reason ?? "",
          byParent: row.publishedBy !== null,
        });
      }
    }
  }

  const presented = presentHistory(rows, contexts, reasons);
  return {
    rows: presented,
    startups: presented.filter((row) => row.kind === "power_on").length,
    truncated,
  };
}

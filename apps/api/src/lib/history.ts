import { and, desc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices, enforcementLog, events, policyVersions } from "../db/schema.js";

/**
 * "What actually happened", as a parent reads it.
 *
 * `enforcement_log` holds one row per agent event, in the agent's own terms:
 * a bedtime shutdown is "Enforced: shutdown" plus "Agent stopped cleanly"
 * TWICE (the enforcer and sync each say it), a power-on is "Agent started",
 * and every rule change is "Applied policy version N". Accurate, and
 * unreadable. This turns those rows into the handful of lines a parent
 * actually wants, at READ time — so history projected before this existed
 * reads the same way, with no backfill.
 *
 * ⚠️ **"Turned on" is decided by the boot ID, never by the word "started".**
 * The enforcer says `agent.started` on every launch: at boot, but also after
 * an install, an upgrade, or launchd restarting it. Only a start on a boot the
 * Mac was not already on is a power-on. A start whose boot is unknown is never
 * called one — that would be claiming something we do not know.
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

/** One `enforcement_log` row, with the boot it happened in. */
export interface RawHistoryRow {
  deviceId: string;
  kind: string;
  summary: string;
  occurredAt: Date;
  policyVersion: number | null;
  detail: unknown;
  bootId: string | null;
}

/** What was true for a device just before the rows being presented. */
export interface DeviceContext {
  /** The boot of the last row before the window; null when unknown. */
  bootBefore: string | null;
  /** Whether the device has ANY history before the window. */
  hasHistoryBefore: boolean;
  /** The last policy version it applied before the window. */
  versionBefore: number | null;
  /** A removed device's last stop is its uninstall, not a shutdown. */
  removed: boolean;
}

/** Why a policy version was made — `policy_versions.reason`, and whether a parent did it. */
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

const EMPTY_CONTEXT: DeviceContext = {
  bootBefore: null,
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
    out.push(...presentDevice(list, contexts.get(deviceId) ?? EMPTY_CONTEXT, reasons));
  }
  // Newest first; within one instant, the row that came LATER in the story
  // first — so a lock and the shutdown in the same second read "locked, then
  // shut down".
  return out
    .sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq)
    .map(({ seq: _seq, ...row }) => row);
}

/** A presented row, plus where in the raw story it happened (for ties). */
type Sequenced = HistoryRow & { seq: number };

function presentDevice(
  rows: RawHistoryRow[],
  context: DeviceContext,
  reasons: Map<string, PolicyReason>,
): Sequenced[] {
  const out: Sequenced[] = [];
  let seq = 0;
  let lastBoot = context.bootBefore;
  let seenAny = context.hasHistoryBefore;
  let lastVersion = context.versionBefore;
  let stop: {
    at: Date;
    lastAt: Date;
    lastSeq: number;
    bootId: string | null;
    bedtime: boolean;
  } | null = null;

  const emit = (
    row: RawHistoryRow | null,
    at: Date,
    kind: string,
    summary: string,
    tone: HistoryTone,
  ) =>
    out.push({
      at: at.toISOString(),
      kind,
      summary,
      deviceId: row?.deviceId ?? "",
      policyVersion: row?.policyVersion ?? null,
      tone,
      seq,
    });

  const emitShutdown = (deviceId: string) => {
    if (!stop) return;
    out.push({
      at: stop.at.toISOString(),
      kind: "power_off",
      summary: stop.bedtime ? HISTORY_TEXT.shutDownAtBedtime : HISTORY_TEXT.shutDown,
      deviceId,
      policyVersion: null,
      tone: "alarm",
      // The Mac went off at the END of its stop, after anything else in it.
      seq: stop.lastSeq,
    });
    stop = null;
  };

  for (const row of rows) {
    seq++;
    // ── A stop: collect the pair of `agent_stopping` rows and any enforced
    // shutdown around them into ONE stop, and decide what it was later —
    // whether the next start is on a new boot is what says "shut down".
    if (isStopPart(row)) {
      const sameEpisode =
        stop !== null &&
        stop.bootId === row.bootId &&
        row.occurredAt.getTime() - stop.lastAt.getTime() <= STOP_EPISODE_MS;
      if (stop && !sameEpisode) emitShutdown(row.deviceId);
      if (!stop) {
        stop = {
          at: row.occurredAt,
          lastAt: row.occurredAt,
          lastSeq: seq,
          bootId: row.bootId,
          bedtime: false,
        };
      }
      stop.lastAt = row.occurredAt;
      stop.lastSeq = seq;
      if (action(row) === "shutdown") stop.bedtime = true;
      lastBoot = row.bootId ?? lastBoot;
      seenAny = true;
      continue;
    }

    const bootChanged = row.bootId !== null && lastBoot !== null && row.bootId !== lastBoot;

    if (bootChanged) {
      // The Mac rebooted. A clean stop before it was the shutdown; without
      // one it went off some other way (power cut, forced restart).
      emitShutdown(row.deviceId);
      emit(row, row.occurredAt, "power_on", HISTORY_TEXT.turnedOn, "alarm");
      lastBoot = row.bootId;
      seenAny = true;
      // The enforcer's own start IS the power-on line; anything else still shows.
      if (row.kind === "agent_started" && !isEnrolmentStart(row)) continue;
    } else if (stop && row.kind === "agent_started" && !isEnrolmentStart(row)) {
      if (row.bootId !== null && row.bootId === stop.bootId) {
        // Stopped and started again without a reboot: an install, an
        // upgrade, or launchd restarting it. Not a power event.
        stop = null;
        emit(row, row.occurredAt, "agent_restarted", HISTORY_TEXT.restarted, "plain");
      } else {
        // Boot unknown on one side — do not claim a power cycle.
        stop = null;
        emit(row, row.occurredAt, "agent_started", HISTORY_TEXT.started, "plain");
      }
      lastBoot = row.bootId ?? lastBoot;
      seenAny = true;
      continue;
    }

    if (row.kind === "agent_started") {
      if (isEnrolmentStart(row)) {
        emit(row, row.occurredAt, "registered", HISTORY_TEXT.registered, "plain");
      } else if (!bootChanged) {
        const kind = seenAny && row.bootId !== null ? "agent_restarted" : "agent_started";
        emit(
          row,
          row.occurredAt,
          kind,
          kind === "agent_restarted" ? HISTORY_TEXT.restarted : HISTORY_TEXT.started,
          "plain",
        );
      }
      lastBoot = row.bootId ?? lastBoot;
      seenAny = true;
      continue;
    }

    if (row.kind === "policy_applied") {
      const version = row.policyVersion;
      lastBoot = row.bootId ?? lastBoot;
      seenAny = true;
      // The same version again is the agent re-applying what it already had
      // after a restart. Nothing reached the Mac.
      if (version !== null && version === lastVersion) continue;
      lastVersion = version ?? lastVersion;
      const why = version === null ? undefined : reasons.get(`${row.deviceId}:${version}`);
      // The nightly top-up of the schedule horizon: nothing changed for the parent.
      if (why?.reason === "calendar" && !why.byParent) continue;
      emit(row, row.occurredAt, "policy_applied", rulesText(why), "plain");
      continue;
    }

    emit(row, row.occurredAt, row.kind, row.summary, "plain");
    lastBoot = row.bootId ?? lastBoot;
    seenAny = true;
  }

  // A stop with nothing after it: the Mac is still off — or, for a removed
  // device, that stop was the uninstall.
  if (stop && rows.length > 0) {
    const deviceId = (rows[0] as RawHistoryRow).deviceId;
    if (context.removed) {
      out.push({
        at: (stop as { at: Date }).at.toISOString(),
        kind: "agent_removed",
        summary: HISTORY_TEXT.removed,
        deviceId,
        policyVersion: null,
        tone: "plain",
        seq: (stop as { lastSeq: number }).lastSeq,
      });
    } else {
      emitShutdown(deviceId);
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

/** The raw rows, joined to the event each came from for its boot ID. */
function rawRows(where: SQL | undefined, limit: number) {
  return db
    .select({
      deviceId: enforcementLog.deviceId,
      kind: enforcementLog.kind,
      summary: enforcementLog.summary,
      occurredAt: enforcementLog.occurredAt,
      policyVersion: enforcementLog.policyVersion,
      detail: enforcementLog.detail,
      bootId: events.bootId,
    })
    .from(enforcementLog)
    .leftJoin(
      events,
      and(eq(events.deviceId, enforcementLog.deviceId), eq(events.eventId, enforcementLog.eventId)),
    )
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
          bootBefore: previous?.bootId ?? null,
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

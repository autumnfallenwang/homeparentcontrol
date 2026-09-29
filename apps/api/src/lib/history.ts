import { and, asc, desc, eq, gte, inArray, lt, lte, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices, enforcementLog, policyVersions } from "../db/schema.js";
import { type Restriction, type RestrictionDocument, restrictionAt } from "./restriction.js";

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
 * ★ **Red means "during watch hours" (ADR 0014)** — after a rule's Until and
 * before its Watch until, judged against the rules that were in force at that
 * moment (`restriction.ts`). Three things turn red there: the Mac turned on,
 * someone unlocked or logged in, or it was on but not reporting. Nothing else
 * is ever red: a bedtime shutdown is the rules working.
 *
 * ⚠️ **"Turned on" comes from two places, never from `boot_id`** — each
 * daemon invents that per PROCESS (ADR 0013):
 * - the server's `power_on` row, written when uptime DROPS between check-ins;
 * - the agent's own `boot_time` on `agent.started`, the kernel's boot time,
 *   which still catches a boot the Mac never checked in from (turned on at
 *   01:00 offline, shut down before morning) once its queue is delivered.
 * The two are merged: boots within two minutes of each other are one boot.
 * History from before either existed keeps one inference: the launch after a
 * shutdown the ENFORCER ordered is the boot.
 */

export type HistoryTone = "alarm" | "plain";

export interface HistoryRow {
  at: string;
  kind: string;
  summary: string;
  deviceId: string;
  policyVersion: number | null;
  /** ★ `alarm` rows are drawn red: something unwanted, during watch hours. */
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
  /** The most recent known boot before the window, in ms. */
  lastBootMs?: number | null;
}

/** Why a policy version was made — `policy_versions.publish_reason`, and whether a parent did it. */
export interface PolicyReason {
  reason: string;
  byParent: boolean;
}

/** Which rule, if any, restricted this device at this moment. */
export type RestrictionLookup = (deviceId: string, at: Date) => Restriction | null;

export const HISTORY_TEXT = {
  turnedOn: "Mac turned on",
  shutDown: "Mac shut down",
  shutDownAtBedtime: "Mac shut down at bedtime",
  started: "Parental controls started",
  restarted: "Parental controls restarted",
  stopped: "Parental controls stopped",
  removed: "Parental controls removed",
  registered: "Mac registered",
  asleep: "Mac asleep",
  rules: {
    enrol: "Mac got its first rules",
    schedule_edit: "Mac got your new rules",
    restore: "Mac got your restored rules",
    override: "Mac got the extra-time change",
    calendar: "Mac got the calendar change",
    other: "Mac got updated rules",
  },
} as const;

/** "during Weekdays' watch hours" — the parent's own name for the rule. */
export function duringWatch(label: string): string {
  return `during ${label}'s watch hours`;
}

/** Rows of one stop within this long of each other are one stop. */
const STOP_EPISODE_MS = 120_000;
/** The enforcer's launch this soon after a boot is that boot, not news. */
const BOOT_LAUNCH_MS = 15 * 60_000;
/** Two boot times this close are the same boot, seen two ways. */
const SAME_BOOT_MS = 120_000;
/** How finely an on-but-not-reporting gap is checked against watch hours. */
const GAP_PROBE_MS = 5 * 60_000;

const EMPTY_CONTEXT: DeviceContext = {
  hasHistoryBefore: false,
  versionBefore: null,
  removed: false,
};
const NOTHING_RESTRICTED: RestrictionLookup = () => null;

function field(row: RawHistoryRow, key: string): unknown {
  return (row.detail as Record<string, unknown> | null)?.[key];
}

function isStopPart(row: RawHistoryRow): boolean {
  return (
    row.kind === "agent_stopping" ||
    (row.kind === "action_taken" && field(row, "action") === "shutdown")
  );
}

/** "1 h 5 m" / "40 m". */
function span(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} m`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} m`;
}

/** A presented row, plus where in the raw story it happened (for ties). */
type Sequenced = HistoryRow & { seq: number };

/**
 * Present raw rows, ASCENDING by time, as the parent's history, NEWEST first.
 * Pure: the rules in force come in as a function, so every rule below has a
 * test that does not need a database.
 */
export function presentHistory(
  rows: RawHistoryRow[],
  contexts: Map<string, DeviceContext> = new Map(),
  reasons: Map<string, PolicyReason> = new Map(),
  restriction: RestrictionLookup = NOTHING_RESTRICTED,
): HistoryRow[] {
  const byDevice = new Map<string, RawHistoryRow[]>();
  for (const row of rows) {
    const list = byDevice.get(row.deviceId) ?? [];
    list.push(row);
    byDevice.set(row.deviceId, list);
  }

  const out: Sequenced[] = [];
  for (const [deviceId, list] of byDevice) {
    out.push(
      ...presentDevice(
        deviceId,
        list,
        contexts.get(deviceId) ?? EMPTY_CONTEXT,
        reasons,
        restriction,
      ),
    );
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
  restriction: RestrictionLookup,
): Sequenced[] {
  const out: Sequenced[] = [];
  let seq = 0;
  let seenAny = context.hasHistoryBefore;
  let lastVersion = context.versionBefore;
  let lastBoot: number | null = context.lastBootMs ?? null;
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

  /** The watch rule this moment falls in, if any. */
  const watching = (at: Date) => {
    const found = restriction(deviceId, at);
    return found?.phase === "watch" ? found : null;
  };

  /** "Mac turned on", red during watch hours. The one place a boot becomes a line. */
  const turnedOn = (at: Date, rowSeq = seq) => {
    lastBoot = at.getTime();
    const watch = watching(at);
    if (watch) {
      push(at, "power_on", `${HISTORY_TEXT.turnedOn} ${duringWatch(watch.label)}`, "alarm", rowSeq);
    } else {
      push(at, "power_on", HISTORY_TEXT.turnedOn, "plain", rowSeq);
    }
  };
  const isKnownBoot = (at: number) => lastBoot !== null && Math.abs(at - lastBoot) < SAME_BOOT_MS;

  /** The Mac went off: at the stop's start, sorted after anything else in it. */
  const shutDown = () => {
    if (!stop) return;
    const text = stop.bedtime ? HISTORY_TEXT.shutDownAtBedtime : HISTORY_TEXT.shutDown;
    push(stop.at, "power_off", text, "plain", stop.lastSeq);
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
      if (field(row, "action") === "shutdown") stop.bedtime = true;
      seenAny = true;
      continue;
    }

    if (row.kind === "power_on") {
      // The server saw the uptime drop: whatever stop came before WAS the shutdown.
      shutDown();
      if (!isKnownBoot(row.occurredAt.getTime())) turnedOn(row.occurredAt);
      seenAny = true;
      continue;
    }

    if (row.kind === "agent_started") {
      const bootText = field(row, "boot_time");
      const bootMs = typeof bootText === "string" ? Date.parse(bootText) : Number.NaN;
      if (field(row, "enrolled") === true) {
        push(row.occurredAt, "registered", HISTORY_TEXT.registered, "plain");
      } else if (!Number.isNaN(bootMs)) {
        // ★ The agent says which boot it launched in (kern.boottime).
        if (isKnownBoot(bootMs)) {
          // This boot is already on record: the launch at boot is not news;
          // a launch long after it is a restart.
          if (stop) stop = null;
          if (row.occurredAt.getTime() - bootMs > BOOT_LAUNCH_MS) {
            push(row.occurredAt, "agent_restarted", HISTORY_TEXT.restarted, "plain");
          }
        } else if (!seenAny && lastBoot === null) {
          // The first thing a device ever says: its install, not a power-on.
          lastBoot = bootMs;
          push(row.occurredAt, "agent_started", HISTORY_TEXT.started, "plain");
        } else {
          shutDown();
          turnedOn(new Date(bootMs));
        }
      } else if (lastBoot !== null && row.occurredAt.getTime() - lastBoot <= BOOT_LAUNCH_MS) {
        // An older agent's launch right after a known boot — that boot.
        if (stop) stop = null;
      } else if (stop?.bedtime) {
        // History from before boot times existed: the enforcer shut the Mac
        // down, so its next launch is the Mac coming back on.
        shutDown();
        turnedOn(row.occurredAt);
      } else if (stop) {
        // Stopped and started with no boot between: an install, an upgrade,
        // or launchd restarting it.
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

    if (row.kind === "session_unlocked") {
      // ★ Listed only during watch hours, and red there. The rest of the day
      // it happens dozens of times and means nothing.
      const watch = watching(row.occurredAt);
      if (watch) {
        const what = field(row, "from") === "asleep" ? "Mac used after waking" : "Mac unlocked";
        push(row.occurredAt, "session_unlocked", `${what} ${duringWatch(watch.label)}`, "alarm");
      }
      seenAny = true;
      continue;
    }

    if (row.kind === "asleep") {
      const asleepS = Number(field(row, "asleep_s") ?? 0);
      push(row.occurredAt, "asleep", `${HISTORY_TEXT.asleep} for ${span(asleepS)}`, "plain");
      continue;
    }

    if (row.kind === "unreported") {
      // Listed only if any of it fell in watch hours: the Mac was ON then and
      // said nothing — Wi-Fi off, a blocked network.
      const to = Date.parse(String(field(row, "to") ?? ""));
      const end = Number.isNaN(to) ? row.occurredAt.getTime() : to;
      let watch: Restriction | null = null;
      for (let t = row.occurredAt.getTime(); t <= end && !watch; t += GAP_PROBE_MS) {
        watch = watching(new Date(t));
      }
      watch ??= watching(new Date(end));
      if (watch) {
        const gapS = (end - row.occurredAt.getTime()) / 1000;
        push(
          row.occurredAt,
          "unreported",
          `Mac on but not reporting for ${span(gapS)} ${duringWatch(watch.label)}`,
          "alarm",
        );
      }
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
  /** ★ Red rows: unwanted, during watch hours. */
  afterBedtime: number;
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

/**
 * For each device, every document it was given, oldest first — so a moment is
 * judged against the rules in force THEN, not the ones in force now.
 */
async function documentsFor(deviceIds: string[], upTo: Date | undefined) {
  const rows = await db
    .select({
      deviceId: policyVersions.deviceId,
      notBefore: policyVersions.notBefore,
      document: policyVersions.document,
    })
    .from(policyVersions)
    .where(
      and(
        inArray(policyVersions.deviceId, deviceIds),
        ...(upTo ? [lte(policyVersions.notBefore, upTo)] : []),
      ),
    )
    .orderBy(asc(policyVersions.notBefore));
  const byDevice = new Map<string, { from: number; document: RestrictionDocument }[]>();
  for (const row of rows) {
    const list = byDevice.get(row.deviceId) ?? [];
    list.push({ from: row.notBefore.getTime(), document: row.document as RestrictionDocument });
    byDevice.set(row.deviceId, list);
  }
  return byDevice;
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
  let restriction: RestrictionLookup = NOTHING_RESTRICTED;

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
        // The latest boot on record before the window, from either source.
        const boots = await rawRows(
          and(before, inArray(enforcementLog.kind, ["power_on", "agent_started"])),
          5,
        );
        const bootTimes = boots.flatMap((row) => {
          if (row.kind === "power_on") return [row.occurredAt.getTime()];
          const text = (row.detail as Record<string, unknown> | null)?.boot_time;
          const ms = typeof text === "string" ? Date.parse(text) : Number.NaN;
          return Number.isNaN(ms) ? [] : [ms];
        });
        contexts.set(deviceId, {
          hasHistoryBefore: previous !== undefined,
          versionBefore: applied?.version ?? null,
          removed: statuses.find((row) => row.id === deviceId)?.status === "decommissioned",
          lastBootMs: bootTimes.length > 0 ? Math.max(...bootTimes) : null,
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

    const documents = await documentsFor(deviceIds, request.to);
    restriction = (deviceId, at) => {
      const list = documents.get(deviceId) ?? [];
      let inForce: RestrictionDocument | null = null;
      for (const entry of list) {
        if (entry.from <= at.getTime()) inForce = entry.document;
        else break;
      }
      return inForce ? restrictionAt(inForce, at) : null;
    };
  }

  const presented = presentHistory(rows, contexts, reasons, restriction);
  return {
    rows: presented,
    startups: presented.filter((row) => row.kind === "power_on").length,
    afterBedtime: presented.filter((row) => row.tone === "alarm").length,
    truncated,
  };
}

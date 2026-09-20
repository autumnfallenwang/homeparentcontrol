import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agentStatusIntervals,
  children,
  devices,
  enforcementLog,
  usageDaily,
  usageHourly,
} from "../db/schema.js";

/**
 * §5.8's **one query service, four sinks** (D.2).
 *
 * ```
 * reportQuery({ householdId, childId?, deviceId?, from, to, grain }) → ReportPayload
 *    ├── dashboard    /reports renders it                     ← built now
 *    ├── on-demand    GET /api/parent/v1/reports returns it    ← built now
 *    ├── digest       digests.payload stores it                ← table exists, off
 *    └── alerts       notifications rows + channel adapter     ← table exists, UI only
 * ```
 *
 * D.2 — whether reporting is delivered as a dashboard, a digest, alerts or
 * an on-demand query — is an **owner decision still open**. The point of this
 * file is that choosing later costs "a config flag and one adapter, never a
 * schema migration or a second query implementation that drifts".
 *
 * ⚠️ **A stored digest renders from its stored `payload`, never by re-running
 * this.** Otherwise last week's email and last week's archived page disagree
 * after any projector fix — which is worse than either being wrong alone,
 * because now the parent cannot tell which to believe.
 *
 * ⚠️ **Reads ROLLUPS, never raw `events`.** Raw samples are pruned at 90 days
 * and rollups are kept for ever (or 400 days), so a report built on raw data
 * would silently lose its own history. M4's exit criterion says this in as
 * many words: "render from projected rollups, not raw events".
 */

export type Grain = "hour" | "day";

export interface ReportRequest {
  householdId: string;
  childId?: string;
  deviceId?: string;
  from: Date;
  /** Exclusive. */
  to: Date;
  grain: Grain;
  /** Cap on the per-bucket app breakdown. The rest is folded into `other`. */
  topApps?: number;
}

export interface UsageBucket {
  /** ISO instant for `hour`; `YYYY-MM-DD` local day for `day`. */
  bucket: string;
  foregroundS: number;
  /** ★ A.33's meter. See ACTIVE_TIME_EXPLANATION — this is use, not uptime. */
  activeS: number;
  apps: { bundleId: string; foregroundS: number; activeS: number }[];
  /**
   * ★ §5.7's first honesty rule: "zero usage and no data look identical on a
   * bar chart and mean opposite things". A bucket the device was reporting
   * through and simply did not use reads `reported: true, activeS: 0`. A
   * bucket it was silent through reads `reported: false`, and the UI must
   * hatch it rather than draw a zero.
   */
  reported: boolean;
}

export interface ReportPayload {
  request: {
    householdId: string;
    childId: string | null;
    deviceId: string | null;
    from: string;
    to: string;
    grain: Grain;
  };
  generatedAt: string;
  totals: { foregroundS: number; activeS: number; reportedBuckets: number; gapBuckets: number };
  buckets: UsageBucket[];
  /** "THIS IS THE PRODUCT, what a parent means when they ask *but what actually happened?*" */
  enforcement: {
    at: string;
    kind: string;
    summary: string;
    deviceId: string;
  }[];
  /** Health history, so a gap in the chart has an explanation next to it. */
  gaps: { from: string; to: string | null; state: string; reason: string | null }[];
}

const DEFAULT_TOP_APPS = 8;

export async function reportQuery(request: ReportRequest): Promise<ReportPayload> {
  const scope = [
    eq(usageHourly.householdId, request.householdId),
    gte(usageHourly.bucketStart, request.from),
    lt(usageHourly.bucketStart, request.to),
  ];
  if (request.childId) scope.push(eq(usageHourly.childId, request.childId));
  if (request.deviceId) scope.push(eq(usageHourly.deviceId, request.deviceId));

  const buckets =
    request.grain === "hour" ? await hourlyBuckets(request, scope) : await dailyBuckets(request);

  // ── Which buckets was the device actually reporting through?
  //
  // Derived from `agent_status_intervals`, not from "did any usage row
  // exist" — a Mac that was on and untouched produces no usage rows at all
  // and must not be drawn as a gap.
  const reported = await reportedRanges(request);
  for (const bucket of buckets) {
    bucket.reported = coversAny(reported, bucket.bucket, request.grain);
  }

  const enforcement = await enforcementRows(request);
  const gaps = await gapRows(request);

  return {
    request: {
      householdId: request.householdId,
      childId: request.childId ?? null,
      deviceId: request.deviceId ?? null,
      from: request.from.toISOString(),
      to: request.to.toISOString(),
      grain: request.grain,
    },
    generatedAt: new Date().toISOString(),
    totals: {
      foregroundS: buckets.reduce((sum, b) => sum + b.foregroundS, 0),
      activeS: buckets.reduce((sum, b) => sum + b.activeS, 0),
      reportedBuckets: buckets.filter((b) => b.reported).length,
      gapBuckets: buckets.filter((b) => !b.reported).length,
    },
    buckets,
    enforcement,
    gaps,
  };
}

// ── Grain: hour

async function hourlyBuckets(
  request: ReportRequest,
  scope: ReturnType<typeof eq>[],
): Promise<UsageBucket[]> {
  const rows = await db
    .select({
      bucketStart: usageHourly.bucketStart,
      bundleId: usageHourly.bundleId,
      foregroundS: usageHourly.foregroundS,
      activeS: usageHourly.activeS,
    })
    .from(usageHourly)
    .where(and(...scope))
    .orderBy(asc(usageHourly.bucketStart));

  return fold(
    rows.map((row) => ({
      bucket: row.bucketStart.toISOString(),
      bundleId: row.bundleId,
      foregroundS: row.foregroundS,
      activeS: row.activeS,
    })),
    request.topApps ?? DEFAULT_TOP_APPS,
  );
}

// ── Grain: day

async function dailyBuckets(request: ReportRequest): Promise<UsageBucket[]> {
  // ⚠️ `usage_daily.local_day` is a DATE in the child's timezone, already
  // resolved by the projector. Re-deriving a local day here from a UTC
  // instant would disagree with it for two hours a night, every night.
  const scope = [
    eq(usageDaily.householdId, request.householdId),
    gte(usageDaily.localDay, isoDay(request.from)),
    lt(usageDaily.localDay, isoDay(request.to)),
  ];
  if (request.childId) scope.push(eq(usageDaily.childId, request.childId));
  if (request.deviceId) scope.push(eq(usageDaily.deviceId, request.deviceId));

  const rows = await db
    .select({
      localDay: usageDaily.localDay,
      bundleId: usageDaily.bundleId,
      foregroundS: usageDaily.foregroundS,
      activeS: usageDaily.activeS,
    })
    .from(usageDaily)
    .where(and(...scope))
    .orderBy(asc(usageDaily.localDay));

  return fold(
    rows.map((row) => ({
      bucket: row.localDay,
      bundleId: row.bundleId,
      foregroundS: row.foregroundS,
      activeS: row.activeS,
    })),
    request.topApps ?? DEFAULT_TOP_APPS,
  );
}

/** Group flat (bucket, bundle) rows into buckets with a capped app list. */
function fold(
  rows: { bucket: string; bundleId: string; foregroundS: number; activeS: number }[],
  topApps: number,
): UsageBucket[] {
  const byBucket = new Map<string, UsageBucket>();
  for (const row of rows) {
    const bucket = byBucket.get(row.bucket) ?? {
      bucket: row.bucket,
      foregroundS: 0,
      activeS: 0,
      apps: [],
      reported: false,
    };
    bucket.foregroundS += row.foregroundS;
    bucket.activeS += row.activeS;
    bucket.apps.push({
      bundleId: row.bundleId,
      foregroundS: row.foregroundS,
      activeS: row.activeS,
    });
    byBucket.set(row.bucket, bucket);
  }

  for (const bucket of byBucket.values()) {
    // ⚠️ Fold the tail into `other` rather than dropping it — the bucket's
    // own totals already include it, so dropping would make the app list
    // silently fail to add up to the bar above it.
    bucket.apps.sort((a, b) => b.activeS - a.activeS || b.foregroundS - a.foregroundS);
    if (bucket.apps.length > topApps) {
      const tail = bucket.apps.splice(topApps);
      bucket.apps.push({
        bundleId: "other",
        foregroundS: tail.reduce((sum, a) => sum + a.foregroundS, 0),
        activeS: tail.reduce((sum, a) => sum + a.activeS, 0),
      });
    }
  }
  return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

// ── Was the device reporting?

interface Range {
  from: Date;
  to: Date;
}

/** States in which the device was known to be delivering telemetry. */
const REPORTING_STATES = ["HEALTHY", "DEGRADED"];

async function reportedRanges(request: ReportRequest): Promise<Range[]> {
  const scope = [
    eq(agentStatusIntervals.householdId, request.householdId),
    lt(agentStatusIntervals.enteredAt, request.to),
    inArray(agentStatusIntervals.state, REPORTING_STATES),
  ];
  if (request.deviceId) scope.push(eq(agentStatusIntervals.deviceId, request.deviceId));

  const rows = await db
    .select({
      enteredAt: agentStatusIntervals.enteredAt,
      exitedAt: agentStatusIntervals.exitedAt,
    })
    .from(agentStatusIntervals)
    .where(and(...scope))
    .orderBy(asc(agentStatusIntervals.enteredAt));

  return rows
    .map((row) => ({ from: row.enteredAt, to: row.exitedAt ?? new Date() }))
    .filter((range) => range.to > request.from);
}

function coversAny(ranges: Range[], bucket: string, grain: Grain): boolean {
  const start = grain === "hour" ? new Date(bucket) : new Date(`${bucket}T00:00:00.000Z`);
  const end = new Date(start.getTime() + (grain === "hour" ? 3_600_000 : 86_400_000));
  // Any overlap counts. A device that reported for ten minutes of an hour
  // reported *something* for that hour, and drawing the hour as a gap would
  // claim we know less than we do.
  return ranges.some((range) => range.from < end && range.to > start);
}

// ── The enforcement log, and the gaps

async function enforcementRows(request: ReportRequest): Promise<ReportPayload["enforcement"]> {
  const scope = [
    eq(enforcementLog.householdId, request.householdId),
    gte(enforcementLog.occurredAt, request.from),
    lt(enforcementLog.occurredAt, request.to),
  ];
  if (request.childId) scope.push(eq(enforcementLog.childId, request.childId));
  if (request.deviceId) scope.push(eq(enforcementLog.deviceId, request.deviceId));

  const rows = await db
    .select({
      occurredAt: enforcementLog.occurredAt,
      kind: enforcementLog.kind,
      summary: enforcementLog.summary,
      deviceId: enforcementLog.deviceId,
    })
    .from(enforcementLog)
    .where(and(...scope))
    .orderBy(desc(enforcementLog.occurredAt))
    .limit(500);

  return rows.map((row) => ({
    at: row.occurredAt.toISOString(),
    kind: row.kind,
    summary: row.summary,
    deviceId: row.deviceId,
  }));
}

async function gapRows(request: ReportRequest): Promise<ReportPayload["gaps"]> {
  const scope = [
    eq(agentStatusIntervals.householdId, request.householdId),
    lt(agentStatusIntervals.enteredAt, request.to),
    sql`${agentStatusIntervals.state} <> 'HEALTHY'`,
  ];
  if (request.deviceId) scope.push(eq(agentStatusIntervals.deviceId, request.deviceId));

  const rows = await db
    .select({
      enteredAt: agentStatusIntervals.enteredAt,
      exitedAt: agentStatusIntervals.exitedAt,
      state: agentStatusIntervals.state,
      reason: agentStatusIntervals.reason,
    })
    .from(agentStatusIntervals)
    .where(and(...scope))
    .orderBy(asc(agentStatusIntervals.enteredAt));

  return rows
    .filter((row) => (row.exitedAt ?? new Date()) > request.from)
    .map((row) => ({
      from: row.enteredAt.toISOString(),
      to: row.exitedAt?.toISOString() ?? null,
      state: row.state,
      reason: row.reason,
    }));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Children in scope, for labelling a payload the caller has to render. */
export async function scopeLabels(householdId: string): Promise<{
  children: { id: string; displayName: string }[];
  devices: { id: string; label: string | null; childId: string | null }[];
}> {
  const [childRows, deviceRows] = await Promise.all([
    db
      .select({ id: children.id, displayName: children.displayName })
      .from(children)
      .where(eq(children.householdId, householdId)),
    db
      .select({ id: devices.id, label: devices.label, childId: devices.childId })
      .from(devices)
      .where(eq(devices.householdId, householdId)),
  ]);
  return { children: childRows, devices: deviceRows };
}

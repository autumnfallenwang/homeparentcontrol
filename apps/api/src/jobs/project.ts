import { appUsageSample, ENFORCEMENT_LOG_KINDS, sessionStateSample } from "@hpc/contract";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  devices,
  enforcementLog,
  events,
  projectionState,
  sessionSpans,
  usageDaily,
  usageHourly,
} from "../db/schema.js";
import { log } from "../lib/logger.js";
import { dateInZone } from "../policy/zoned-time.js";

/**
 * The projector (§5.7) — every 5 minutes, watermarked on `received_at`,
 * **recomputing whole buckets**.
 *
 * ```
 * w      = projection_state.watermark_received_at
 * rows   = events WHERE received_at > w ORDER BY received_at LIMIT 50_000
 * dirty  = distinct (device_id, date_trunc('hour', ts)) over rows
 * for each dirty bucket: RECOMPUTE THE WHOLE BUCKET from events, then upsert
 * projection_state.watermark_received_at = max(rows.received_at)
 * ```
 *
 * ⚠️ **Recomputing rather than incrementing is the whole design.** An
 * incremental projector must know whether it already counted a row — a second
 * idempotency problem on top of the one `event_id` already solves. A full
 * recompute is idempotent by construction, and at ~85 rows per bucket it costs
 * nothing.
 *
 * ⚠️ **Keyed on `received_at`, never `ts`.** The agent's clock is advisory,
 * and a child stepping it backwards would otherwise push her own events
 * permanently behind a `ts`-based watermark.
 */

const BATCH_LIMIT = 50_000;

/** The one watermark. §5.2 names three; one pass projects all three targets. */
const WATERMARK = "projection";

export interface ProjectionResult {
  scanned: number;
  dirtyBuckets: number;
  usageRows: number;
  enforcementRows: number;
  sessionSpans: number;
  unprojectable: number;
}

/** A device-hour. The unit of recomputation. */
interface Bucket {
  deviceId: string;
  hour: Date;
}

export async function projectEvents(
  opts: { since?: Date; advanceWatermark?: boolean } = {},
): Promise<ProjectionResult> {
  const advance = opts.advanceWatermark ?? true;
  // ⚠️ Read as TEXT, not as a Date, for the same reason it is written as text
  // — a JS Date has millisecond precision and Postgres timestamptz has
  // microseconds. Reading `.213379` into a Date and sending back `.213` makes
  // `received_at > watermark` true for the very row the watermark came from,
  // so the projector re-scans its newest rows on every single run and never
  // advances. Idempotent, invisible, and unbounded work.
  const [state] = await db.execute<{ w: string }>(sql`
    SELECT watermark_received_at::text AS w FROM projection_state WHERE name = ${WATERMARK}`);
  const watermark = opts.since ? opts.since.toISOString() : (state?.w ?? "epoch");

  const scanned = await db
    .select({
      deviceId: events.deviceId,
      receivedAt: events.receivedAt,
      // ⚠️ Carried as TEXT as well, and the watermark is written from this.
      //
      // Postgres `timestamptz` has MICROSECOND precision; a JS `Date` has
      // milliseconds. Round-tripping the watermark through a Date silently
      // truncates, so the stored watermark lands fractionally BEFORE the row
      // it came from — and `received_at > watermark` matches that row again
      // on the next run, for ever. The projector is idempotent so nothing
      // corrupts, but it never advances past its newest row and re-does
      // unbounded work. Caught by "does not reprocess what it has already
      // seen"; invisible in production except as rising CPU.
      receivedAtText: sql<string>`${events.receivedAt}::text`.as("received_at_text"),
      hour: sql<Date>`date_trunc('hour', ${events.ts})`.as("hour"),
    })
    .from(events)
    .where(sql`${events.receivedAt} > ${watermark}::timestamptz`)
    .orderBy(asc(events.receivedAt))
    .limit(BATCH_LIMIT);

  const result: ProjectionResult = {
    scanned: scanned.length,
    dirtyBuckets: 0,
    usageRows: 0,
    enforcementRows: 0,
    sessionSpans: 0,
    unprojectable: 0,
  };

  // Nothing new. Leave the watermark exactly where it is.
  if (scanned.length === 0) return result;

  // ⚠️ F7 — DROP THE TRAILING PARTIAL TIMESTAMP GROUP.
  //
  // `events.received_at` defaults to `now()`, and Postgres `now()` is the
  // TRANSACTION timestamp — so every row of one multi-row batch insert shares
  // an identical `received_at`. If the LIMIT cuts inside such a group, the
  // strict `received_at > w` on the next run skips the remainder of that group
  // permanently. Those events are stored, durable, acknowledged, and never
  // projected: exactly the silent evaporation the retention invariant exists
  // to prevent, arriving by a different route.
  //
  // So when the batch is full, discard the last timestamp group and let the
  // next run pick it up whole.
  let usable = scanned;
  if (scanned.length === BATCH_LIMIT) {
    const lastTs = scanned[scanned.length - 1]?.receivedAt.getTime();
    usable = scanned.filter((r) => r.receivedAt.getTime() !== lastTs);
    if (usable.length === 0) {
      // A single timestamp group larger than the whole batch. Cannot make
      // progress without processing it, and dropping it would lose data.
      log.warn(
        {
          event: "projection.oversized_group",
          received_at: scanned[0]?.receivedAt,
          rows: scanned.length,
        },
        "one received_at group exceeds the batch limit; processing it whole",
      );
      usable = scanned;
    }
  }
  result.scanned = usable.length;

  // distinct (device_id, hour) over the scanned rows.
  //
  // ⚠️ Bucketed on `ts`, which §5.7 elsewhere says never to trust. That is as
  // written and it is right: the WATERMARK must be on `received_at` so a
  // stepped clock cannot hide events, but the BUCKET is what the parent reads
  // as "Tuesday evening", which is wall-clock. A stepped clock therefore puts
  // usage in the wrong hour. §4.4 asserts "the reporting layer corrects
  // against received_at"; no such correction is specified anywhere, and none
  // is invented here. The `clock.stepped` audit event is the marker.
  const dirty = new Map<string, Bucket>();
  for (const row of usable) {
    const hour = new Date(row.hour);
    dirty.set(`${row.deviceId}|${hour.toISOString()}`, { deviceId: row.deviceId, hour });
  }
  result.dirtyBuckets = dirty.size;

  // The rows came back ordered by received_at ASC, so the last one is the max.
  // Full precision, as text, never via a Date.
  const maxReceivedAt = usable[usable.length - 1]?.receivedAtText;

  for (const bucket of dirty.values()) {
    const bucketResult = await recomputeBucket(bucket);
    result.usageRows += bucketResult.usageRows;
    result.enforcementRows += bucketResult.enforcementRows;
    result.sessionSpans += bucketResult.sessionSpans;
    result.unprojectable += bucketResult.unprojectable;
  }

  // ⚠️ Advance only to the newest row we actually SAW, and only when this is
  // the forward pass. The nightly re-projection must NOT rewind the watermark
  // (F13): rewinding would re-scan up to 48 h through the LIMIT and make the
  // watermark non-monotonic while the 5-minute job may be mid-run. A full
  // recompute is idempotent, so the nightly pass is safe as a pure side-pass.
  if (advance && maxReceivedAt) await touchWatermark(maxReceivedAt, result.dirtyBuckets);

  log.info({ event: "projection.completed", ...result }, "projection finished");
  return result;
}

/** `to` is a Postgres timestamp literal, at full precision. See the scan. */
async function touchWatermark(to: string, rows: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO projection_state (name, watermark_received_at, last_run_at, last_run_rows)
    VALUES (${WATERMARK}, ${to}::timestamptz, now(), ${rows})
    ON CONFLICT (name) DO UPDATE SET
      watermark_received_at = ${to}::timestamptz,
      last_run_at = now(),
      last_run_rows = ${rows},
      last_error = NULL`);
}

/** Everything one device-hour produces, recomputed from scratch. */
async function recomputeBucket(bucket: Bucket): Promise<{
  usageRows: number;
  enforcementRows: number;
  sessionSpans: number;
  unprojectable: number;
}> {
  const nextHour = new Date(bucket.hour.getTime() + 3_600_000);

  const [device] = await db
    .select({ householdId: devices.householdId, childId: devices.childId })
    .from(devices)
    .where(eq(devices.id, bucket.deviceId));
  if (!device) return { usageRows: 0, enforcementRows: 0, sessionSpans: 0, unprojectable: 0 };

  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.deviceId, bucket.deviceId),
        gte(events.ts, bucket.hour),
        lt(events.ts, nextHour),
      ),
    )
    // `ts` breaks ties: events outside the enforcer's sequence all carry
    // `seq = -1` (ADR 0010), and without it their order is whatever the heap
    // returns. Advisory, but the only order those events have.
    .orderBy(asc(events.bootId), asc(events.seq), asc(events.ts));

  const base = {
    householdId: device.householdId,
    deviceId: bucket.deviceId,
    childId: device.childId,
  };
  let unprojectable = 0;

  // ── usage_hourly: one row per (device, hour, bundle), fully recomputed.
  const perBundle = new Map<
    string,
    { foregroundS: number; activeS: number; cpuTotal: number; n: number }
  >();
  for (const row of rows) {
    if (row.type !== "app.usage_sample") continue;
    const parsed = appUsageSample.safeParse(row.data);
    if (!parsed.success) {
      unprojectable++;
      continue;
    }
    const d = parsed.data;
    const acc = perBundle.get(d.bundle_id) ?? { foregroundS: 0, activeS: 0, cpuTotal: 0, n: 0 };
    acc.foregroundS += Math.round(d.foreground_s ?? 0);
    acc.activeS += Math.round(d.active_s ?? 0);
    acc.cpuTotal += d.cpu_pct ?? 0;
    acc.n += 1;
    perBundle.set(d.bundle_id, acc);
  }

  // Delete-then-insert, so a bundle that vanished from the recomputed bucket
  // does not linger. This is what "recompute the whole bucket" means.
  await db
    .delete(usageHourly)
    .where(
      and(eq(usageHourly.deviceId, bucket.deviceId), eq(usageHourly.bucketStart, bucket.hour)),
    );

  if (perBundle.size > 0) {
    await db.insert(usageHourly).values(
      [...perBundle.entries()].map(([bundleId, acc]) => ({
        ...base,
        bucketStart: bucket.hour,
        bundleId,
        foregroundS: acc.foregroundS,
        activeS: acc.activeS,
        // The DB column is an int in basis points; the wire is a float percent.
        cpuPctAvg: acc.n > 0 ? Math.round((acc.cpuTotal / acc.n) * 100) : 0,
        sampleCount: Math.min(acc.n, 32_767),
      })),
    );
  }

  // ── enforcement_log: "THIS IS THE PRODUCT". Unique on event_id, so an
  // upsert makes the recompute idempotent without a delete pass.
  let enforcementRows = 0;
  for (const row of rows) {
    const kind = ENFORCEMENT_LOG_KINDS[row.type];
    if (!kind) continue;
    await db
      .insert(enforcementLog)
      .values({
        ...base,
        eventId: row.eventId,
        kind,
        occurredAt: row.ts,
        policyVersion: readInt(row.data, "policy_version"),
        summary: summarise(kind, row.data),
        detail: row.data,
      })
      .onConflictDoUpdate({
        target: enforcementLog.eventId,
        set: { kind, summary: summarise(kind, row.data), detail: row.data },
      });
    enforcementRows++;
  }

  // ── session_spans: transitions become spans.
  //
  // ⚠️ Cleared before rewriting, not just upserted. The unique key is
  // (device, kind, started_at), so if a recompute shifts a start by one sample
  // the upsert INSERTS a duplicate and orphans the old row rather than
  // updating it — and the bucket silently gains a span. "Recompute the whole
  // bucket" has to mean delete-then-write for anything whose key can move.
  let spans = 0;
  //
  // ★ In TIME order, not the query's (boot_id, seq) order (#3, 2026-09-28).
  // `boot_id` is a per-PROCESS random UUID and every `session.state` comes from
  // sync with `seq = -1`, so a sync restart inside the hour made the two halves
  // sort in whichever order their UUIDs fell — "active 15:45 → 15:23", and
  // several spans open at once.
  const transitions = rows
    .filter((r) => r.type === "session.state")
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  // The first transition after this hour closes the hour's last span.
  const [after] = await db
    .select({ ts: events.ts })
    .from(events)
    .where(
      and(
        eq(events.deviceId, bucket.deviceId),
        eq(events.type, "session.state"),
        gte(events.ts, nextHour),
      ),
    )
    .orderBy(asc(events.ts))
    .limit(1);
  await db
    .delete(sessionSpans)
    .where(
      and(
        eq(sessionSpans.deviceId, bucket.deviceId),
        gte(sessionSpans.startedAt, bucket.hour),
        lt(sessionSpans.startedAt, nextHour),
      ),
    );
  for (let i = 0; i < transitions.length; i++) {
    const row = transitions[i];
    if (!row) continue;
    const parsed = sessionStateSample.safeParse(row.data);
    if (!parsed.success) {
      unprojectable++;
      continue;
    }
    const endedAt = transitions[i + 1]?.ts ?? after?.ts ?? null;
    await db
      .insert(sessionSpans)
      .values({
        ...base,
        kind: parsed.data.state,
        startedAt: row.ts,
        // Closed by the next transition, in this hour or a later one; open
        // only when there is none yet.
        endedAt,
        bootId: row.bootId,
        consoleUser: parsed.data.console_user ?? null,
        endInferred: false,
      })
      .onConflictDoUpdate({
        target: [sessionSpans.deviceId, sessionSpans.kind, sessionSpans.startedAt],
        set: { endedAt, consoleUser: parsed.data.console_user ?? null },
      });
    spans++;
  }

  // ── Unlocks (ADR 0014): the Mac going from locked — which includes the
  // login window — or asleep, to in use. That is the moment a person started
  // using it, and what the parent's history flags inside watch hours. The
  // state BEFORE this hour is looked up, so an unlock at 01:00 after a lock
  // at 23:55 is not missed at the hour boundary.
  if (transitions.length > 0) {
    const [before] = await db
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.deviceId, bucket.deviceId),
          eq(events.type, "session.state"),
          lt(events.ts, (transitions[0] as { ts: Date }).ts),
        ),
      )
      .orderBy(desc(events.ts))
      .limit(1);
    let previous = sessionStateSample.safeParse(before?.data).data?.state ?? null;
    for (const row of transitions) {
      const state = sessionStateSample.safeParse(row.data).data?.state ?? null;
      if (!state) continue;
      if (
        (previous === "locked" || previous === "asleep") &&
        (state === "awake" || state === "active")
      ) {
        const detail = { from: previous, to: state };
        const summary = previous === "locked" ? "Mac unlocked" : "Mac used after waking";
        await db
          .insert(enforcementLog)
          .values({
            ...base,
            eventId: row.eventId,
            kind: "session_unlocked",
            occurredAt: row.ts,
            summary,
            detail,
          })
          .onConflictDoUpdate({ target: enforcementLog.eventId, set: { summary, detail } });
        enforcementRows++;
      }
      previous = state;
    }
  }

  // A span an EARLIER hour left open — because its closing transition had not
  // arrived when that hour was projected — closes at the first transition
  // after it. Without this it stays "→ now" for ever: that hour is never dirty
  // again.
  await db.execute(sql`
    UPDATE session_spans s
       SET ended_at = (
         SELECT min(e.ts) FROM events e
          WHERE e.device_id = s.device_id
            AND e.type = 'session.state'
            AND e.ts > s.started_at)
     WHERE s.device_id = ${bucket.deviceId}
       AND s.ended_at IS NULL
       AND s.started_at < ${bucket.hour.toISOString()}::timestamptz`);

  return { usageRows: perBundle.size, enforcementRows, sessionSpans: spans, unprojectable };
}

function readInt(data: unknown, key: string): number | null {
  const value = (data as Record<string, unknown> | null)?.[key];
  return typeof value === "number" ? Math.round(value) : null;
}

/**
 * The one denormalised human-readable line the report renders. Composed at
 * projection time "so a schema change to `detail` cannot break old history".
 */
function summarise(kind: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "warning_shown":
      return `Warning shown ${d.lead_minutes ?? "?"} minutes before bedtime`;
    case "action_taken":
      return `Enforced: ${String(d.action ?? "action")}`;
    case "action_failed":
      return `Enforcement FAILED: ${String(d.action ?? "action")} — ${String(d.error ?? "unknown")}`;
    case "policy_applied":
      return `Applied policy version ${d.policy_version ?? "?"}`;
    case "policy_rejected":
      return `Rejected a policy: ${String(d.reason ?? "unknown")}`;
    case "degraded":
      return `Not enforcing: ${String(d.reason ?? "unknown")}`;
    case "clock_stepped": {
      // ADR 0015 — wall − trusted, from agent 0.2.0.
      const offset = Number(d.offset_s ?? Number.NaN);
      if (Number.isNaN(offset)) return "System clock was stepped";
      return Math.abs(offset) <= 60
        ? "Clock back to the real time"
        : `Clock set ${Math.round(Math.abs(offset) / 60)} min ${offset > 0 ? "ahead" : "behind"}`;
    }
    case "network_time_off":
      return "Set time automatically was turned off";
    case "timezone_changed":
      return `Time zone changed to ${String(d.to ?? "?")}`;
    case "override_granted":
      return `Extra time granted: ${d.minutes ?? "?"} minutes`;
    case "override_expired":
      return "Extra time ended";
    // §5.7's first honesty rule — gaps are data. Zero usage and no data look
    // identical on a chart and mean opposite things.
    case "queue_evicted":
      return `${d.count ?? "Some"} events were dropped before they could be sent`;
    case "kill_switch_present":
      return "A kill switch file was found on the Mac";
    case "agent_started":
      return "Agent started";
    case "agent_stopping":
      return "Agent stopped cleanly";
    default:
      return kind.replace(/_/g, " ");
  }
}

/**
 * Roll `usage_hourly` into `usage_daily`.
 *
 * ⚠️ **LOCAL day in the policy timezone**, never `date_trunc('day', ts)` in
 * UTC. Get it wrong and Sunday evening shows up on Monday — the first thing a
 * parent notices and the last thing anyone checks.
 */
export async function rollUpDaily(opts: { sinceDays?: number } = {}): Promise<number> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 3) * 86_400_000);

  const hours = await db
    .select({
      householdId: usageHourly.householdId,
      deviceId: usageHourly.deviceId,
      childId: usageHourly.childId,
      bucketStart: usageHourly.bucketStart,
      bundleId: usageHourly.bundleId,
      foregroundS: usageHourly.foregroundS,
      activeS: usageHourly.activeS,
      timezone: sql<string>`coalesce(${devices.id}::text, '')`.as("ignored"),
    })
    .from(usageHourly)
    .innerJoin(devices, eq(devices.id, usageHourly.deviceId))
    .where(gte(usageHourly.bucketStart, since));

  if (hours.length === 0) return 0;

  // Resolve each device's zone once — the compiler's rule: child's zone wins
  // over the household's (A.30).
  const zones = await deviceTimezones([...new Set(hours.map((h) => h.deviceId))]);

  const daily = new Map<string, typeof usageDaily.$inferInsert>();
  for (const h of hours) {
    const tz = zones.get(h.deviceId) ?? "UTC";
    const localDay = dateInZone(h.bucketStart, tz);
    const key = `${h.deviceId}|${localDay}|${h.bundleId}`;
    const acc = daily.get(key) ?? {
      householdId: h.householdId,
      deviceId: h.deviceId,
      childId: h.childId,
      localDay,
      bundleId: h.bundleId,
      foregroundS: 0,
      activeS: 0,
    };
    acc.foregroundS = (acc.foregroundS ?? 0) + h.foregroundS;
    acc.activeS = (acc.activeS ?? 0) + h.activeS;
    daily.set(key, acc);
  }

  for (const row of daily.values()) {
    await db
      .insert(usageDaily)
      .values(row)
      .onConflictDoUpdate({
        target: [usageDaily.deviceId, usageDaily.localDay, usageDaily.bundleId],
        set: {
          foregroundS: row.foregroundS,
          activeS: row.activeS,
          projectedAt: sql`now()`,
        },
      });
  }

  log.info({ event: "rollup.completed", days: daily.size }, "daily rollup finished");
  return daily.size;
}

async function deviceTimezones(deviceIds: string[]): Promise<Map<string, string>> {
  const rows = await db.query.devices.findMany({
    where: (d, { inArray }) => inArray(d.id, deviceIds),
    with: { child: true, household: true },
  });
  return new Map(
    rows.map((r) => [r.id, r.child?.timezone ?? r.household?.timezone ?? "UTC"] as const),
  );
}

/**
 * The nightly pass: re-project the trailing 48 hours unconditionally.
 *
 * ⚠️ Not redundant with the watermark. The watermark only ever moves forward,
 * so an event that arrives with an OLD `ts` — a queue draining after a long
 * outage — lands in a bucket the incremental pass already considered done.
 * Recomputing 48 hours catches it, and because recomputation is idempotent it
 * costs nothing when there is nothing to fix.
 */
export async function reprojectTrailing48h(): Promise<ProjectionResult> {
  // Trailing 48 h of `received_at`, not of `ts` — the purpose is to absorb
  // whatever the watermark logic got wrong, and the watermark is on
  // `received_at`. A fortnight-old bucket drained today is covered by one and
  // missed by the other.
  const since = new Date(Date.now() - 48 * 3_600_000);
  const result = await projectEvents({ since, advanceWatermark: false });
  await rollUpDaily({ sinceDays: 3 });
  return result;
}

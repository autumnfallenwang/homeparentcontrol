import { and, eq, lt, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { agentStatusIntervals, events, usageHourly } from "../db/schema.js";
import { log } from "../lib/logger.js";

/**
 * The nightly retention prune (§5.7).
 *
 * The ladder exists so a pruned window is still *visibly* pruned in a report
 * rather than silently absent: raw samples are the bulk and go first, while
 * everything projected from them outlives them by a wide margin.
 *
 * | what                    | kept  | why |
 * |-------------------------|-------|-----|
 * | `events` class=sample   | 90 d  | the bulk; already projected into usage_hourly |
 * | `events` class=audit    | 400 d | the "what actually happened" record |
 * | `usage_hourly`          | 400 d | rolled up into usage_daily first |
 * | `agent_status_intervals`| 400 d | the health history |
 * | `usage_daily`           | ∞     | the long-term summary; deliberately never pruned |
 *
 * ⚠️ `config.assertRetentionInvariant` refuses to start when sample retention
 * does not exceed the agent's max queue age. Without that, a long outage
 * delivers events that are ingested and then pruned *before* the projector
 * touches them — data that arrived, was stored, and evaporated, with no error
 * anywhere.
 */

export interface PruneResult {
  sampleEvents: number;
  auditEvents: number;
  usageHourly: number;
  agentStatusIntervals: number;
}

const days = (n: number) => sql`now() - ${`${n} days`}::interval`;

export async function pruneRetention(): Promise<PruneResult> {
  // ⚠️ Every predicate is on `received_at` / `entered_at`, never on `ts`.
  // `ts` is the agent's clock and is advisory; a device with a wrong clock
  // must not be able to make its own rows immortal or delete them early.
  // `events_received_at_brin_idx` exists for exactly this scan.
  const sampleEvents = await db
    .delete(events)
    .where(
      and(eq(events.class, "sample"), lt(events.receivedAt, days(config.rawSampleRetentionDays))),
    )
    .returning({ id: events.eventId });

  const auditEvents = await db
    .delete(events)
    .where(
      and(eq(events.class, "audit"), lt(events.receivedAt, days(config.rawAuditRetentionDays))),
    )
    .returning({ id: events.eventId });

  const hourly = await db
    .delete(usageHourly)
    .where(lt(usageHourly.bucketStart, days(config.usageHourlyRetentionDays)))
    .returning({ id: usageHourly.id });

  // Only CLOSED intervals. An open one is the device's current state — pruning
  // it would erase the fact that a Mac has been silent for a very long time,
  // which is the single thing that history is for.
  const intervals = await db
    .delete(agentStatusIntervals)
    .where(
      and(
        lt(agentStatusIntervals.enteredAt, days(config.agentStatusRetentionDays)),
        sql`${agentStatusIntervals.exitedAt} IS NOT NULL`,
      ),
    )
    .returning({ id: agentStatusIntervals.id });

  const result: PruneResult = {
    sampleEvents: sampleEvents.length,
    auditEvents: auditEvents.length,
    usageHourly: hourly.length,
    agentStatusIntervals: intervals.length,
  };

  log.info({ event: "prune.completed", ...result }, "retention prune finished");
  return result;
}

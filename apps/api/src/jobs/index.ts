import { gte } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { policySets } from "../db/schema.js";
import { log } from "../lib/logger.js";
import { type Job, startScheduler } from "../lib/scheduler.js";
import { closeExpiredRotations } from "../routes/credential.js";
import { evaluateLiveness } from "./liveness.js";
import { projectEvents, reprojectTrailing48h, rollUpDaily } from "./project.js";
import { pruneRetention } from "./prune.js";
import { recompileHorizons } from "./recompile.js";

/**
 * The three in-process jobs §5.8 specifies: liveness 60 s, projection 5 min,
 * nightly.
 *
 * ⚠️ "The house already solved this: `replicaCount: 1` + `strategy: Recreate`
 * guarantees no overlap." That is the ONLY thing making a bare `setInterval`
 * safe here. If replicas ever exceed 1, the liveness job needs
 * `pg_try_advisory_lock` and so does the projector.
 */

/**
 * ⚠️ The projector and the nightly re-projection both recompute buckets, and
 * §5.8's single-replica premise does NOT protect them from each other — they
 * are two `setInterval`s in one event loop, and both are async, so they
 * interleave at every `await`. Nothing in the spec guards this. One mutex.
 */
let projectionBusy: Promise<unknown> | null = null;

async function exclusive<T>(work: () => Promise<T>): Promise<T | null> {
  if (projectionBusy) {
    log.info({ event: "projection.skipped" }, "another projection pass is running");
    return null;
  }
  const running = work();
  projectionBusy = running;
  try {
    return await running;
  } finally {
    projectionBusy = null;
  }
}

/**
 * ⚠️ F15 — the boot assertion guards an env-var MIRROR of the agent's queue
 * age, but the real value lives per policy set and a parent can edit it. A
 * policy set raised to 120 days silently defeats the invariant: events would
 * be pruned before the projector ever saw them, with no error anywhere. The
 * boot check cannot see this; the nightly job can.
 */
async function assertLiveRetentionInvariant(): Promise<void> {
  const offenders = await db
    .select({ id: policySets.id, days: policySets.telemetryMaxQueueAgeDays })
    .from(policySets)
    .where(gte(policySets.telemetryMaxQueueAgeDays, config.rawSampleRetentionDays));

  for (const row of offenders) {
    log.error(
      {
        event: "retention.invariant_violated",
        policy_set_id: row.id,
        max_queue_age_days: row.days,
        raw_sample_retention_days: config.rawSampleRetentionDays,
      },
      "a policy set allows a queue older than raw retention; events can be pruned before projection",
    );
  }
}

export const jobs: Job[] = [
  {
    name: "liveness",
    everyMs: 60_000,
    runOnStart: true,
    run: async () => {
      await evaluateLiveness();
    },
  },
  {
    name: "projection",
    everyMs: 5 * 60_000,
    run: async () => {
      await exclusive(async () => {
        await projectEvents();
        await rollUpDaily();
      });
    },
  },
  {
    name: "nightly",
    // ⚠️ Not a cron — a plain interval, so "nightly" means "every 24 h since
    // boot", not "at 03:00". §5.8 calls it nightly and specifies no clock
    // time; a restart therefore shifts it. Everything it does is idempotent,
    // so the drift is harmless, but it is not what the word implies.
    everyMs: 24 * 3_600_000,
    run: async () => {
      await assertLiveRetentionInvariant();
      await exclusive(() => reprojectTrailing48h());
      await pruneRetention();
      // Close every credential-rotation overlap whose 24 h has passed.
      // ⚠️ Belt and braces — `apikeys.expiresAt` already ends the window
      // inside better-auth, so a night when this job does not run costs
      // nothing. It disables the superseded row as well, so an expired
      // credential cannot come back by someone clearing an `expiresAt` they
      // took for stale data.
      await closeExpiredRotations();
      // The job the spec forgot: without it the 21-day horizon freezes on the
      // day a device enrols and no holiday ever reaches it again.
      await recompileHorizons();
    },
  },
];

export function startJobs(): void {
  startScheduler(jobs);
}

export { evaluateLiveness, projectEvents, pruneRetention, recompileHorizons, rollUpDaily };

import { log } from "./logger.js";

/**
 * In-process periodic jobs (§5.8).
 *
 * Three of them: liveness 60 s, projection 5 min, and the nightly. No queue, no
 * cron container, no leader election — "the house already solved this:
 * `replicaCount: 1` + `strategy: Recreate` guarantees no overlap."
 *
 * ⚠️ That guarantee is the ONLY thing making this safe. If `replicaCount` ever
 * exceeds 1, two copies of every job run concurrently: the projector would
 * double-advance its watermark and the liveness job would race itself writing
 * interval rows. §5.8 names `pg_try_advisory_lock` as the fix. Until then the
 * chart pinning one replica is load-bearing infrastructure, not a default.
 */

export interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
  /** Run once at startup rather than waiting a full interval. */
  runOnStart?: boolean;
}

const timers = new Map<string, NodeJS.Timeout>();
/** Names currently executing — a slow run must not overlap its own next tick. */
const inFlight = new Set<string>();

/**
 * Run one tick, with the two properties that matter: a job can never overlap
 * itself, and a throw can never kill the process or stop the schedule.
 *
 * An unhandled rejection inside a `setInterval` callback takes the whole
 * process down under Node's default policy — which for a 60-second liveness
 * job means one bad row stops all health reporting until someone notices.
 */
async function tick(job: Job): Promise<void> {
  if (inFlight.has(job.name)) {
    log.warn(
      { event: "scheduler.overlap", job: job.name },
      "previous run still in flight; skipping this tick",
    );
    return;
  }
  inFlight.add(job.name);
  const startedAt = Date.now();
  try {
    await job.run();
    log.debug(
      { event: "scheduler.ran", job: job.name, duration_ms: Date.now() - startedAt },
      "scheduled job finished",
    );
  } catch (err) {
    log.error(
      { event: "scheduler.failed", job: job.name, duration_ms: Date.now() - startedAt, err },
      "scheduled job threw; the schedule continues",
    );
  } finally {
    inFlight.delete(job.name);
  }
}

/** Start every job. Idempotent per name, so a double call cannot double-schedule. */
export function startScheduler(jobs: Job[]): void {
  for (const job of jobs) {
    if (timers.has(job.name)) continue;
    const timer = setInterval(() => void tick(job), job.everyMs);
    // Do not hold the event loop open — the HTTP server owns process lifetime.
    timer.unref();
    timers.set(job.name, timer);
    log.info(
      { event: "scheduler.started", job: job.name, every_ms: job.everyMs },
      "scheduled job registered",
    );
    if (job.runOnStart) void tick(job);
  }
}

/** Stop everything. Used by tests and by a graceful shutdown. */
export function stopScheduler(): void {
  for (const [name, timer] of timers) {
    clearInterval(timer);
    timers.delete(name);
  }
}

/** Test seam: run one job's body once, synchronously awaited, bypassing the timer. */
export async function runJobNow(job: Job): Promise<void> {
  await tick(job);
}

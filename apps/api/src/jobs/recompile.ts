import { ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices } from "../db/schema.js";
import { log } from "../lib/logger.js";
import { publishPolicy } from "../policy/publish.js";

/**
 * The nightly policy recompile — **the job the spec forgot**.
 *
 * §5.6 sends calendar exceptions and holidays to a device on a rolling 21-day
 * horizon. Nothing in the design document ever recompiles a policy after
 * enrolment: §9 step 5 lists a nightly job and calls it only "the nightly
 * prune". So as written, the horizon freezes on the day a device enrols and
 * **no holiday or calendar exception ever reaches it again** — the device goes
 * on enforcing the baseline schedule for ever, correctly and uselessly.
 *
 * It is cheap precisely because of the churn-killer: `publishPolicy` compares
 * the content hash and returns `unchanged` without writing when nothing has
 * moved. On a quiet night every device is a hash comparison and no new row.
 * On the night a holiday enters the horizon, exactly the affected devices get
 * a new version.
 *
 * ⚠️ `reason: "calendar"`, because that is what actually changed — the
 * horizon advanced over a date. Not `schedule_edit`: nobody edited anything.
 */
export interface RecompileResult {
  considered: number;
  published: number;
  unchanged: number;
  failed: number;
}

export async function recompileHorizons(now?: Date): Promise<RecompileResult> {
  // A decommissioned device is retired: no new policy, ever. Everything else
  // gets one, including `pending` and `revoked` — a revoked device keeps
  // enforcing (X1b), so it must keep getting correct policy to enforce.
  const active = await db
    .select({ id: devices.id })
    .from(devices)
    .where(ne(devices.status, "decommissioned"));

  const result: RecompileResult = {
    considered: active.length,
    published: 0,
    unchanged: 0,
    failed: 0,
  };

  for (const device of active) {
    try {
      const outcome = await publishPolicy({ deviceId: device.id, reason: "calendar", now });
      if (outcome.status === "published") result.published++;
      else result.unchanged++;
    } catch (err) {
      // One device with broken authoring state must not stop the other Macs
      // in the house from getting their policy rolled forward.
      result.failed++;
      log.error(
        { event: "recompile.device_failed", device_id: device.id, err },
        "could not recompile this device's policy; continuing",
      );
    }
  }

  log.info({ event: "recompile.completed", ...result }, "nightly horizon recompile finished");
  return result;
}

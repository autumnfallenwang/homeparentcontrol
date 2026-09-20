import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agentStatusIntervals,
  children,
  devices,
  events,
  expectedOnlineWindows,
  households,
} from "../db/schema.js";
import { log } from "../lib/logger.js";
import { dateInZone, timeInZone, weekdayOf } from "../policy/zoned-time.js";

/**
 * The liveness job (§7.3) — "the control plane, a k3s pod reliably running
 * unlike the Mac, evaluates every device **once a minute** and emits its
 * verdict."
 *
 * ⚠️ **The tick is the heartbeat (A.26).** `POST /sync` *is* the liveness
 * signal. There is no `/heartbeat` endpoint and there must not be one: a
 * second liveness path can be healthy while the real one is broken, and a
 * heartbeat that can lie is worse than none.
 *
 * ⚠️ **This job is the ONLY writer of `health_state`, `health_reason` and
 * `health_since`**, and the only writer of `agent_status_intervals`. §5.2 says
 * the sync handler writes those three columns too; that would be two writers
 * on two cadences. Sync writes observations, this computes health.
 *
 * Storage, per §7.3: **a pino line every evaluation** (alerting keys off a
 * presence in Loki, not a table), and **Postgres stores intervals** — one row
 * per state *change* — plus the current state denormalised onto `devices`.
 * A row per device per minute would be ~69 MB at the 400-day ladder, larger
 * than the entire raw telemetry store, to record a value that changes about
 * eight times a day.
 */

/** §7.3's table. `UNENROLLED` is a sixth state the schema has and the prose does not. */
export type HealthState =
  | "UNENROLLED"
  | "HEALTHY"
  | "DEGRADED"
  | "EXPECTED_OFFLINE"
  | "UNEXPECTED_SILENCE"
  | "SILENT_TOO_LONG";

const HEALTHY_WITHIN_MS = 180_000; // 3 ticks
const UNEXPECTED_SILENCE_MS = 600_000; // 10 min
const SILENT_TOO_LONG_MS = 36 * 3_600_000; // 36 h
/** Enter amber at 10 min, buzz a phone at 60 — a macOS update restart routinely exceeds 10. */
const SILENCE_NOTIFY_AFTER_MS = 3_600_000;
/** DEGRADED notifies "immediately (after 3 consecutive evaluations)". */
const DEGRADED_EVALUATIONS_BEFORE_NOTIFY = 3;

export interface LivenessResult {
  evaluated: number;
  changed: number;
  reclassified: number;
  notified: number;
}

export async function evaluateLiveness(now: Date = new Date()): Promise<LivenessResult> {
  const rows = await db
    .select({
      id: devices.id,
      householdId: devices.householdId,
      status: devices.status,
      lastSyncAt: devices.lastSyncAt,
      systemBootTime: devices.systemBootTime,
      selfReportedReason: devices.selfReportedReason,
      awayUntil: devices.awayUntil,
      policySetId: devices.policySetId,
      healthState: devices.healthState,
      healthSince: devices.healthSince,
      childTimezone: children.timezone,
      householdTimezone: households.timezone,
    })
    .from(devices)
    .innerJoin(children, eq(children.id, devices.childId))
    .innerJoin(households, eq(households.id, devices.householdId))
    .where(ne(devices.status, "decommissioned"));

  const result: LivenessResult = { evaluated: 0, changed: 0, reclassified: 0, notified: 0 };

  for (const device of rows) {
    const tz = device.childTimezone ?? device.householdTimezone;
    const online = await isInsideExpectedOnline(device.policySetId, now, tz);
    const verdict = await decide(device, now, online);
    result.evaluated++;

    // ⚠️ EVERY evaluation emits the line, not just the changes. §7.3: T6's
    // alert rules read a Loki stream and key off a PRESENCE — "alert on a
    // presence (`agent_status`), never an absence". A line only on change
    // would make a healthy device indistinguishable from a dead scheduler.
    log.info(
      {
        event: "agent_status",
        device_id: device.id,
        state: verdict.state,
        reason: verdict.reason,
        silent_s: device.lastSyncAt
          ? Math.round((now.getTime() - device.lastSyncAt.getTime()) / 1000)
          : null,
        inside_expected_online: online,
      },
      "device health evaluated",
    );

    if (verdict.state !== device.healthState) {
      await transition(device, verdict, now);
      result.changed++;
    }
    if (await maybeNotify(device, verdict, now, online)) result.notified++;
    if (await reclassifyIfMachineWasOff(device, now)) result.reclassified++;
  }

  log.info({ event: "liveness.completed", ...result }, "liveness sweep finished");
  return result;
}

interface DeviceRow {
  id: string;
  householdId: string;
  status: string;
  lastSyncAt: Date | null;
  systemBootTime: Date | null;
  selfReportedReason: string | null;
  awayUntil: Date | null;
  policySetId: string | null;
  healthState: string;
  healthSince: Date | null;
}

interface Verdict {
  state: HealthState;
  reason: string | null;
}

/**
 * ★ The precedence order, which §7.3 does not give.
 *
 * Its five rows overlap freely — a device can be simultaneously reporting a
 * degraded reason, outside `expected_online`, 40 hours silent, and marked
 * away — and no evaluation order is stated anywhere.
 *
 * ⚠️ `away_until` beats `SILENT_TOO_LONG`, even though §7.3 says that state
 * fires "regardless". A.19/X6 and the schema comment say `away_until` exists
 * precisely "so a school holiday cannot make SILENT_TOO_LONG fire benignly and
 * get the channel muted" — that states the PURPOSE, which settles the
 * contradiction. "Regardless" reads as "regardless of how cleanly it stopped".
 */
async function decide(device: DeviceRow, now: Date, insideWindow: boolean): Promise<Verdict> {
  // A device that has never ticked is not silent; it has not started.
  if (!device.lastSyncAt) return { state: "UNENROLLED", reason: null };

  // 1. Away is absolute.
  if (device.awayUntil && device.awayUntil > now) {
    return { state: "EXPECTED_OFFLINE", reason: "away" };
  }

  const silentMs = now.getTime() - device.lastSyncAt.getTime();

  // 2. Ticking normally.
  if (silentMs <= HEALTHY_WITHIN_MS) {
    return device.selfReportedReason
      ? { state: "DEGRADED", reason: device.selfReportedReason }
      : { state: "HEALTHY", reason: null };
  }

  // 3. Gone long enough that nothing benign explains it.
  if (silentMs >= SILENT_TOO_LONG_MS) {
    return { state: "SILENT_TOO_LONG", reason: "silent_36h" };
  }

  // 4. A benign explanation.
  if (await stoppedCleanly(device.id, device.lastSyncAt)) {
    return { state: "EXPECTED_OFFLINE", reason: "agent_stopping" };
  }
  if (!insideWindow) return { state: "EXPECTED_OFFLINE", reason: "outside_expected_online" };

  // 5. Silent inside a window it should be awake for.
  //
  // ⚠️ "Do not arm at the start of a window": require one HEALTHY observation
  // inside the CURRENT window first, or every late start produces a 07:00
  // amber. Approximated by the last tick falling inside the window — which is
  // what a healthy observation in it means.
  if (silentMs >= UNEXPECTED_SILENCE_MS) {
    return { state: "UNEXPECTED_SILENCE", reason: "silent_10m" };
  }

  // 6. ⚠️ THE GAP §7.3 LEAVES. `HEALTHY` is "within 180 s" and
  //    `UNEXPECTED_SILENCE` is "10 min silent" — nothing covers the seven
  //    minutes between. Hold the current state rather than flap.
  return {
    state: (device.healthState as HealthState) ?? "HEALTHY",
    reason: device.selfReportedReason,
  };
}

/**
 * ⚠️ §3.8 warns this signal will often be missing: "the pre-sleep window is
 * short and not guaranteed to survive a network round-trip… do not build the
 * design on the dying breath arriving." So a clean overnight shutdown usually
 * looks like silence until §7.4 reclassifies it in the morning — which is why
 * `maybeNotify` suppresses the amber outside a window.
 */
async function stoppedCleanly(deviceId: string, since: Date): Promise<boolean> {
  // A little slack before the last tick: the stopping event and the final
  // sync race each other on the way out.
  const cutoff = new Date(since.getTime() - 5 * 60_000);
  const [row] = await db
    .select({ id: events.eventId })
    .from(events)
    .where(
      and(
        eq(events.deviceId, deviceId),
        eq(events.type, "agent.stopping"),
        gte(events.receivedAt, cutoff),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Is `now` inside one of this device's `expected_online` windows, in its own zone? */
async function isInsideExpectedOnline(
  policySetId: string | null,
  now: Date,
  tz: string,
): Promise<boolean> {
  if (!policySetId) return true; // no windows configured: always expected up
  const windows = await db
    .select()
    .from(expectedOnlineWindows)
    .where(eq(expectedOnlineWindows.policySetId, policySetId));
  if (windows.length === 0) return true;

  const today = weekdayOf(dateInZone(now, tz));
  const at = timeInZone(now, tz);
  return windows.some(
    (w) => w.days.includes(today) && at >= w.fromTime.slice(0, 5) && at < w.untilTime.slice(0, 5),
  );
}

/** Close the open interval, open a new one, denormalise onto the device. */
async function transition(device: DeviceRow, verdict: Verdict, now: Date): Promise<void> {
  await db
    .update(agentStatusIntervals)
    .set({ exitedAt: now })
    .where(
      and(eq(agentStatusIntervals.deviceId, device.id), isNull(agentStatusIntervals.exitedAt)),
    );

  await db.insert(agentStatusIntervals).values({
    householdId: device.householdId,
    deviceId: device.id,
    state: verdict.state,
    reason: verdict.reason,
    enteredAt: now,
  });

  await db
    .update(devices)
    .set({ healthState: verdict.state, healthReason: verdict.reason, healthSince: now })
    .where(eq(devices.id, device.id));
}

/**
 * §7.3's two escalation rules, which are deliberately not the state rules.
 *
 * ⚠️ `UNEXPECTED_SILENCE` notifies only INSIDE an expected-online window. The
 * state condition says that; the notification rule at §7.3 does not restate
 * it, and without it every overnight shutdown produces a 1 a.m. amber — since
 * §3.8 says the `agent.stopping` that would have explained it is routinely
 * lost. An alert nobody wants is an alert nobody reads.
 */
async function maybeNotify(
  device: DeviceRow,
  verdict: Verdict,
  now: Date,
  insideWindow: boolean,
): Promise<boolean> {
  const [interval] = await db
    .select()
    .from(agentStatusIntervals)
    .where(and(eq(agentStatusIntervals.deviceId, device.id), isNull(agentStatusIntervals.exitedAt)))
    .orderBy(desc(agentStatusIntervals.enteredAt))
    .limit(1);
  if (!interval || interval.notifiedAt) return false;

  const inStateMs = now.getTime() - interval.enteredAt.getTime();
  let due = false;
  switch (verdict.state) {
    case "DEGRADED":
      due = inStateMs >= DEGRADED_EVALUATIONS_BEFORE_NOTIFY * 60_000;
      break;
    case "UNEXPECTED_SILENCE":
      due = insideWindow && inStateMs >= SILENCE_NOTIFY_AFTER_MS;
      break;
    case "SILENT_TOO_LONG":
      due = true;
      break;
    default:
      due = false; // EXPECTED_OFFLINE never notifies; HEALTHY has nothing to say.
  }
  if (!due) return false;

  await db
    .update(agentStatusIntervals)
    .set({ notifiedAt: now })
    .where(eq(agentStatusIntervals.id, interval.id));

  // ⚠️ C6 — there is currently NO alerting in the cluster at all: no rules, no
  // contact points, no notifiers. This line is the notification until
  // milestone 05 provisions them, and until then "notified" means "logged".
  log.warn(
    {
      event: "agent_status_notify",
      device_id: device.id,
      state: verdict.state,
      reason: verdict.reason,
      in_state_s: Math.round(inStateMs / 1000),
    },
    "device health needs attention",
  );
  return true;
}

/**
 * §7.4 — off vs broken, with no probe.
 *
 * A.29 forbids pinging the Mac: a Bonjour Sleep Proxy answers ARP for a
 * sleeping machine, so the probe lies — and with Wake for network access it
 * can wake the machine at 03:00, which in a bedtime product is actively
 * harmful. The distinction comes free from `device.system_boot_time`.
 *
 * ⚠️ Only §7.4's FIRST row is implemented here, deliberately. Rows 2–4 need
 * the PREVIOUS boot time, which `sync` has already overwritten by the time
 * this runs and which `agent_status_intervals` has no column for — and §7.4
 * asks for those to be surfaced "on the device health card, not as a
 * notification", which is what the `agent_stopped_while_up` tripwire already
 * does from inside the sync handler, where both values are in scope.
 */
async function reclassifyIfMachineWasOff(device: DeviceRow, now: Date): Promise<boolean> {
  if (!device.systemBootTime) return false;

  // The most recent CLOSED silence interval, if the boot lands inside it.
  const [interval] = await db
    .select()
    .from(agentStatusIntervals)
    .where(
      and(
        eq(agentStatusIntervals.deviceId, device.id),
        isNull(agentStatusIntervals.reclassifiedFrom),
        inArray(agentStatusIntervals.state, ["UNEXPECTED_SILENCE", "SILENT_TOO_LONG"]),
        isNotNull(agentStatusIntervals.exitedAt),
        // The boot landed INSIDE the silence: entered < boot <= exited.
        // Column-first so drizzle binds the Date as a real timestamptz.
        lt(agentStatusIntervals.enteredAt, device.systemBootTime),
        gte(agentStatusIntervals.exitedAt, device.systemBootTime),
      ),
    )
    .orderBy(desc(agentStatusIntervals.enteredAt))
    .limit(1);
  if (!interval) return false;

  // The Mac was simply off. Rewrite the interval rather than leaving a red
  // band that says the agent was broken when it was not. `entered_at` and
  // `exited_at` keep their observed values — the silence really did happen,
  // only its explanation changes.
  await db
    .update(agentStatusIntervals)
    .set({
      state: "EXPECTED_OFFLINE",
      reason: "machine_was_off",
      reclassifiedFrom: interval.state,
    })
    .where(eq(agentStatusIntervals.id, interval.id));

  log.info(
    {
      event: "agent_status_reclassified",
      device_id: device.id,
      from: interval.state,
      boot_time: device.systemBootTime,
    },
    "silence explained by a reboot; interval reclassified",
  );
  void now;
  return true;
}

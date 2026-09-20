import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentStatusIntervals, devices, enforcementLog, events } from "../db/schema.js";

/**
 * §6.5's shadow-mode soak, assessed server-side.
 *
 * > "The n=1 form that survives compares against the server-side record
 * > instead: the candidate emits `enforcement.shadow_decision` events and the
 * > control plane diffs them against `enforcement_log`'s history for
 * > equivalent inputs."
 *
 * ⚠️ **Shadow decisions are NOT `enforcement_log` rows and must never
 * become them.** That table is "what actually happened" — the thing a parent
 * reads when they ask *but what actually happened?* A decision that was
 * deliberately not carried out is a different kind of fact, and mixing the
 * two would corrupt the one record the product is built on.
 * `ENFORCEMENT_LOG_KINDS` deliberately omits `enforcement.shadow_decision`,
 * so the projector counts it unprojectable and leaves it in `events`. This
 * module reads it from there.
 *
 * ⚠️ **This is advisory.** Nothing here can extend a soak: the agent's
 * deadline is baked into its own marker and the server cannot move it. The
 * worst a broken report can do is fail to promote early, and the deadline
 * still ends the soak. See `ShadowMode`'s header for why that direction.
 */

export const SHADOW_EVENT_TYPE = "enforcement.shadow_decision";

/** §6.5: "≥24 h and ≥1 full bedtime window". */
export const SOAK_MIN_MS = 24 * 3_600_000;
/** How far back to look for the behaviour a shadow decision is compared against. */
export const HISTORY_DAYS = 14;

export interface SoakReport {
  deviceId: string;
  /** Null when the device is not soaking. */
  version: string | null;
  startedAt: string | null;
  elapsedS: number;
  /** A release can declare its divergences, so an intentional fix does not fail its own soak. */
  expectDivergence: boolean;
  evidence: {
    completedBedtimeWindows: number;
    crashes: number;
    heartbeatGaps: number;
    unexpectedDivergences: number;
  };
  divergences: {
    windowId: string | null;
    wouldNow: string[];
    didHistorically: string[];
    /** ⚠️ The direction that matters. */
    severity: "would_stop_enforcing" | "would_start_enforcing" | "different_action";
  }[];
  promote: boolean;
  reason: string;
}

export async function soakReport(deviceId: string, now = new Date()): Promise<SoakReport> {
  const shadowRows = await db
    .select({ ts: events.ts, data: events.data })
    .from(events)
    .where(and(eq(events.deviceId, deviceId), eq(events.type, SHADOW_EVENT_TYPE)))
    .orderBy(desc(events.ts))
    .limit(5000);

  const empty: SoakReport = {
    deviceId,
    version: null,
    startedAt: null,
    elapsedS: 0,
    expectDivergence: false,
    evidence: {
      completedBedtimeWindows: 0,
      crashes: 0,
      heartbeatGaps: 0,
      unexpectedDivergences: 0,
    },
    divergences: [],
    promote: false,
    reason: "no shadow decisions reported — this device is not soaking",
  };
  if (shadowRows.length === 0) return empty;

  const parsed = shadowRows
    .map((row) => ({ ts: row.ts, ...parseShadow(row.data) }))
    .filter((row): row is ParsedShadow & { ts: Date } => row.version !== null);
  if (parsed.length === 0) return empty;

  // The soak is the one the NEWEST decision names. An older version's
  // decisions are history, not this soak.
  const first = parsed[0];
  if (!first) return empty;
  const version = first.version;
  const mine = parsed.filter((row) => row.version === version);
  const startedAt = mine.reduce(
    (earliest, row) => (row.ts < earliest ? row.ts : earliest),
    first.ts,
  );
  const elapsedS = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
  const expectDivergence = mine.some((row) => row.expectDivergence);

  // ── What the shadow version would do, per window.
  const wouldByWindow = new Map<string, Set<string>>();
  for (const row of mine) {
    const key = row.windowId ?? "";
    const set = wouldByWindow.get(key) ?? new Set<string>();
    for (const action of row.would) set.add(normalise(action));
    wouldByWindow.set(key, set);
  }

  // ── What actually happened, historically, for the same windows.
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  const historyRows = await db
    .select({ windowId: enforcementLog.windowId, kind: enforcementLog.kind })
    .from(enforcementLog)
    .where(
      and(
        eq(enforcementLog.deviceId, deviceId),
        gte(enforcementLog.occurredAt, since),
        inArray(enforcementLog.kind, ["action_taken", "warning_shown"]),
      ),
    );

  const didByWindow = new Map<string, Set<string>>();
  for (const row of historyRows) {
    const key = row.windowId ?? "";
    const set = didByWindow.get(key) ?? new Set<string>();
    set.add(row.kind === "action_taken" ? "lock" : "warn");
    didByWindow.set(key, set);
  }

  // ── The diff.
  //
  // ⚠️ Asymmetric on purpose. "The new version would NOT lock where the old
  // one did" is the failure this whole mechanism exists to catch; the
  // reverse is worth reporting but is not the same kind of danger.
  const divergences: SoakReport["divergences"] = [];
  for (const [key, would] of wouldByWindow) {
    const did = didByWindow.get(key) ?? new Set<string>();
    const wouldLock = would.has("lock") || would.has("shutdown");
    const didLock = did.has("lock");
    if (wouldLock === didLock) continue;
    divergences.push({
      windowId: key || null,
      wouldNow: [...would].sort(),
      didHistorically: [...did].sort(),
      severity: didLock && !wouldLock ? "would_stop_enforcing" : "would_start_enforcing",
    });
  }

  // ── The rest of §6.5's criteria.
  const [crashRow] = await db
    .select({ n: sql<string>`count(*)::text` })
    .from(events)
    .where(
      and(
        eq(events.deviceId, deviceId),
        eq(events.type, "agent.started"),
        gte(events.ts, startedAt),
      ),
    );
  // ⚠️ The FIRST `agent.started` is the install itself, not a crash.
  const crashes = Math.max(0, Number(crashRow?.n ?? "0") - 1);

  const gapRows = await db
    .select({ state: agentStatusIntervals.state })
    .from(agentStatusIntervals)
    .where(
      and(
        eq(agentStatusIntervals.deviceId, deviceId),
        gte(agentStatusIntervals.enteredAt, startedAt),
        sql`${agentStatusIntervals.state} IN ('UNEXPECTED_SILENCE', 'SILENT_TOO_LONG')`,
      ),
    );

  // A "completed bedtime window" is a window the shadow version saw open and
  // close — approximated by having produced a `lock` decision for it and
  // later stopped. ⚠️ Counted per distinct window, not per decision: a
  // 60-second tick produces hundreds of identical decisions for one night.
  const completedBedtimeWindows = [...wouldByWindow.entries()].filter(
    ([key, would]) => key !== "" && (would.has("lock") || would.has("shutdown")),
  ).length;

  const evidence = {
    completedBedtimeWindows,
    crashes,
    heartbeatGaps: gapRows.length,
    // A declared divergence is not unexpected.
    unexpectedDivergences: expectDivergence ? 0 : divergences.length,
  };

  const reason = firstFailure(elapsedS, evidence);
  return {
    deviceId,
    version,
    startedAt: startedAt.toISOString(),
    elapsedS,
    expectDivergence,
    evidence,
    divergences,
    promote: reason === null,
    reason: reason ?? "all soak criteria met",
  };
}

function firstFailure(elapsedS: number, evidence: SoakReport["evidence"]): string | null {
  if (elapsedS * 1000 < SOAK_MIN_MS) return "under 24 h";
  if (evidence.completedBedtimeWindows < 1) return "no complete bedtime window yet";
  if (evidence.crashes > 0) return `${evidence.crashes} crash(es) during the soak`;
  if (evidence.heartbeatGaps > 0) return `${evidence.heartbeatGaps} heartbeat gap(s)`;
  if (evidence.unexpectedDivergences > 0) {
    return `${evidence.unexpectedDivergences} unexplained decision divergence(s)`;
  }
  return null;
}

interface ParsedShadow {
  version: string | null;
  windowId: string | null;
  would: string[];
  expectDivergence: boolean;
}

/**
 * ⚠️ Tolerant, and it has to be: the agent serialises `would` as a stringified
 * array because the spool carries `[String: String]`. R8 says the transport
 * knows nothing about `data`, so this reader accepts either shape rather
 * than rejecting an event that is already stored.
 */
function parseShadow(data: unknown): ParsedShadow {
  const row = (data ?? {}) as Record<string, unknown>;
  const rawWould = row.would;
  let would: string[] = [];
  if (Array.isArray(rawWould)) {
    would = rawWould.map(String);
  } else if (typeof rawWould === "string") {
    // `["lock"]` as text, which is what `String(describing:)` produces.
    would = rawWould
      .replace(/[[\]"']/g, "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return {
    version: typeof row.shadow_version === "string" ? row.shadow_version : null,
    windowId: typeof row.window_id === "string" ? row.window_id : null,
    would,
    expectDivergence: row.expect_divergence === true || row.expect_divergence === "true",
  };
}

function normalise(action: string): string {
  if (action.startsWith("warn")) return "warn";
  return action;
}

/** Is this device currently soaking? Cheap enough for the `/today` card. */
export async function isSoaking(deviceId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ ts: events.ts })
    .from(events)
    .where(and(eq(events.deviceId, deviceId), eq(events.type, SHADOW_EVENT_TYPE)))
    .orderBy(desc(events.ts))
    .limit(1);
  if (!row) return false;
  // ⚠️ A shadow decision older than two ticks means the agent stopped
  // shadowing — it does not announce promotion, it simply stops saying it.
  return now.getTime() - row.ts.getTime() < 180_000;
}

/** Devices in the household that are soaking right now. */
export async function soakingDevices(householdId: string): Promise<string[]> {
  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.householdId, householdId));
  const soaking: string[] = [];
  for (const row of rows) {
    if (await isSoaking(row.id)) soaking.push(row.id);
  }
  return soaking;
}

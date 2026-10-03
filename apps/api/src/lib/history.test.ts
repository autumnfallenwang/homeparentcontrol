import { describe, expect, it } from "vitest";
import {
  bedtimeUse,
  clockSetText,
  clockWasText,
  type DeviceContext,
  duringWatch,
  HISTORY_TEXT,
  type PolicyReason,
  presentHistory,
  type RawHistoryRow,
  type RestrictionLookup,
  usedInBedtime,
  zoneName,
} from "./history.js";

const DEVICE = "d1";

/** Minutes (and seconds) past 16:00 UTC on the test day. */
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 8, 28, 16, minute, second));

function row(kind: string, when: Date, extra: Partial<RawHistoryRow> = {}): RawHistoryRow {
  return {
    deviceId: DEVICE,
    kind,
    summary: `raw ${kind}`,
    occurredAt: when,
    policyVersion: null,
    detail: {},
    ...extra,
  };
}

const stopping = (minute: number, second = 0) => row("agent_stopping", at(minute, second));
const shutdown = (minute: number, second = 0) =>
  row("action_taken", at(minute, second), { detail: { action: "shutdown" } });
const lock = (minute: number, second = 0) =>
  row("action_taken", at(minute, second), {
    detail: { action: "lock" },
    summary: "Enforced: lock",
  });
/** An OLD agent's launch: no boot time. */
const started = (minute: number, second = 0) => row("agent_started", at(minute, second));
/** A NEW agent's launch, carrying the kernel's boot time. */
const startedInBoot = (minute: number, bootMinute: number) =>
  row("agent_started", at(minute), { detail: { boot_time: at(bootMinute).toISOString() } });
/** The SERVER's row: the Mac's uptime dropped between two check-ins. */
const poweredOn = (minute: number) =>
  row("power_on", at(minute), { summary: "Mac turned on", detail: { source: "server" } });
const unlocked = (minute: number, from = "locked") =>
  row("session_unlocked", at(minute), { detail: { from, to: "awake" } });
const asleep = (minute: number, asleepS: number) =>
  row("asleep", at(minute), { detail: { asleep_s: asleepS, source: "server" } });
const unreported = (minute: number, toMinute: number) =>
  row("unreported", at(minute), { detail: { to: at(toMinute).toISOString(), source: "server" } });
const applied = (minute: number, version: number) =>
  row("policy_applied", at(minute), { policyVersion: version });

const known = (extra: Partial<DeviceContext> = {}) =>
  new Map<string, DeviceContext>([
    [DEVICE, { hasHistoryBefore: true, versionBefore: null, removed: false, ...extra }],
  ]);

/** Watch hours from minute 30 to minute 50 ("Weekdays"); enforcement 20–30. */
const bedtime: RestrictionLookup = (_device, when) => {
  const minute = (when.getTime() - at(0).getTime()) / 60_000;
  if (minute >= 20 && minute < 30) return { phase: "enforced", windowId: "w", label: "Weekdays" };
  if (minute >= 30 && minute < 50) return { phase: "watch", windowId: "w", label: "Weekdays" };
  return null;
};

/** Oldest first, which is how a parent reads a story; the function returns newest first. */
const story = (rows: ReturnType<typeof presentHistory>) =>
  rows.map((r) => `${r.summary}${r.tone === "alarm" ? " [red]" : ""}`).reverse();

const present = (rows: RawHistoryRow[], ctx = known(), reasons = new Map<string, PolicyReason>()) =>
  presentHistory(rows, ctx, reasons, bedtime);

describe("presentHistory — red means watch hours (ADR 0014)", () => {
  it("★ a startup during watch hours is red and names the rule", () => {
    expect(story(present([poweredOn(35), started(35, 20)]))).toEqual([
      `${HISTORY_TEXT.turnedOn} ${duringWatch("Weekdays")} [red]`,
    ]);
  });

  it("★ a startup outside watch hours is listed, plain", () => {
    expect(story(present([poweredOn(55)]))).toEqual([HISTORY_TEXT.turnedOn]);
  });

  it("★ a startup during ENFORCEMENT is not red — the Mac itself is handling it", () => {
    expect(story(present([poweredOn(25)]))).toEqual([HISTORY_TEXT.turnedOn]);
  });

  it("★ an unlock during watch hours is red; outside them it is not listed at all", () => {
    expect(story(present([unlocked(10), unlocked(25), unlocked(40), unlocked(55)]))).toEqual([
      `Mac unlocked ${duringWatch("Weekdays")} [red]`,
    ]);
  });

  it("using it straight after waking, with no lock screen, says so", () => {
    expect(story(present([unlocked(40, "asleep")]))).toEqual([
      `Mac used after waking ${duringWatch("Weekdays")} [red]`,
    ]);
  });

  it("★ on but not reporting is red only if any of it touched watch hours", () => {
    expect(story(present([unreported(45, 70)]))).toEqual([
      `Mac on but not reporting for 25 m ${duringWatch("Weekdays")} [red]`,
    ]);
    // Entirely in the afternoon: not listed.
    expect(present([unreported(52, 58)])).toEqual([]);
  });

  it("a sleep is a plain line with how long", () => {
    expect(story(present([asleep(0, 3900)]))).toEqual(["Mac asleep for 1 h 5 m"]);
  });

  it("★ a bedtime shutdown is plain — it is the rules working", () => {
    const out = present([shutdown(21), stopping(21), stopping(21, 1), poweredOn(55)]);
    expect(story(out)).toEqual([HISTORY_TEXT.shutDownAtBedtime, HISTORY_TEXT.turnedOn]);
    expect(out.some((r) => r.tone === "alarm")).toBe(false);
  });
});

describe("presentHistory — startups, from either source", () => {
  it("★ the agent's own boot time catches a boot the server never saw", () => {
    // Turned on at minute 36, used offline, delivered hours later: no server row.
    expect(story(present([stopping(21), stopping(21, 1), startedInBoot(37, 36)]))).toEqual([
      HISTORY_TEXT.shutDown,
      `${HISTORY_TEXT.turnedOn} ${duringWatch("Weekdays")} [red]`,
    ]);
  });

  it("★ the same boot seen by the server AND the agent is one line", () => {
    const rows = [poweredOn(36), startedInBoot(36, 36)];
    expect(present(rows).filter((r) => r.kind === "power_on")).toHaveLength(1);
  });

  it("a launch in a boot already on record, long after it, is a restart", () => {
    const rows = [poweredOn(0), startedInBoot(40, 0)];
    expect(story(present(rows))).toEqual([HISTORY_TEXT.turnedOn, HISTORY_TEXT.restarted]);
  });

  it("the boot before the window counts as known", () => {
    expect(story(present([startedInBoot(40, 0)], known({ lastBootMs: at(0).getTime() })))).toEqual([
      HISTORY_TEXT.restarted,
    ]);
  });

  it("★ the first launch a device ever reports is its install, then registration", () => {
    const rows = [startedInBoot(1, 0), row("agent_started", at(2), { detail: { enrolled: true } })];
    expect(story(presentHistory(rows, new Map(), new Map(), bedtime))).toEqual([
      HISTORY_TEXT.started,
      HISTORY_TEXT.registered,
    ]);
  });

  it("★ older history: the launch after a BEDTIME shutdown is the Mac coming back on", () => {
    const rows = [shutdown(21, 5), stopping(21, 5), stopping(21, 5), started(36)];
    expect(story(present(rows))).toEqual([
      HISTORY_TEXT.shutDownAtBedtime,
      `${HISTORY_TEXT.turnedOn} ${duringWatch("Weekdays")} [red]`,
    ]);
  });

  it("★ an old agent's stop and start with no boot between is a restart, never a power event", () => {
    const out = present([stopping(10), stopping(10, 1), started(11)]);
    expect(story(out)).toEqual([HISTORY_TEXT.restarted]);
    expect(out.some((r) => r.kind === "power_on")).toBe(false);
  });

  it("an old agent's launch just after a server power-on is that boot", () => {
    expect(story(present([poweredOn(55), started(55, 20)]))).toEqual([HISTORY_TEXT.turnedOn]);
  });
});

describe("presentHistory — stops", () => {
  it("a stop nothing explains yet is plain 'stopped', not a guessed shutdown", () => {
    expect(story(present([stopping(10), stopping(10, 1)]))).toEqual([HISTORY_TEXT.stopped]);
  });

  it("a Mac still off after a bedtime shutdown shows the shutdown", () => {
    expect(story(present([shutdown(21), stopping(21)]))).toEqual([HISTORY_TEXT.shutDownAtBedtime]);
  });

  it("a removed device's last stop is its uninstall", () => {
    expect(story(present([stopping(21), stopping(21, 1)], known({ removed: true })))).toEqual([
      HISTORY_TEXT.removed,
    ]);
  });

  it("a lock in the same second as the shutdown does not split the stop, and reads first", () => {
    expect(story(present([shutdown(21), lock(21), stopping(21), poweredOn(55)]))).toEqual([
      "Enforced: lock",
      HISTORY_TEXT.shutDownAtBedtime,
      HISTORY_TEXT.turnedOn,
    ]);
  });
});

describe("presentHistory — rules", () => {
  const reasons = new Map<string, PolicyReason>([
    [`${DEVICE}:1`, { reason: "enrol", byParent: false }],
    [`${DEVICE}:2`, { reason: "schedule_edit", byParent: true }],
    [`${DEVICE}:3`, { reason: "calendar", byParent: false }],
    [`${DEVICE}:4`, { reason: "override", byParent: true }],
    [`${DEVICE}:5`, { reason: "calendar", byParent: true }],
    [`${DEVICE}:6`, { reason: "restore", byParent: true }],
  ]);

  it("★ says why the Mac got new rules, in words, never a version number", () => {
    const rows = [
      applied(1, 1),
      applied(2, 2),
      applied(4, 4),
      applied(5, 5),
      applied(6, 6),
      applied(7, 9),
    ];
    const out = story(present(rows, known(), reasons));
    expect(out).toEqual([
      HISTORY_TEXT.rules.enrol,
      HISTORY_TEXT.rules.schedule_edit,
      HISTORY_TEXT.rules.override,
      HISTORY_TEXT.rules.calendar,
      HISTORY_TEXT.rules.restore,
      HISTORY_TEXT.rules.other,
    ]);
    expect(out.join(" ")).not.toMatch(/version/i);
  });

  it("★ hides the nightly refresh, and the same version re-applied", () => {
    expect(present([applied(3, 3)], known(), reasons)).toEqual([]);
    expect(present([applied(1, 2)], known({ versionBefore: 2 }), reasons)).toEqual([]);
  });
});

describe("presentHistory — shape", () => {
  it("returns newest first, across devices", () => {
    const other = { ...started(30), deviceId: "d2" };
    const out = presentHistory([started(10), other]);
    expect(out.map((r) => r.at)).toEqual([at(30).toISOString(), at(10).toISOString()]);
  });

  it("with no rules in force, nothing is red", () => {
    const out = presentHistory([poweredOn(35), unlocked(40)], known());
    expect(out.some((r) => r.tone === "alarm")).toBe(false);
  });
});

describe("presentHistory — the moves around the rules, red at any hour (ADR 0015)", () => {
  const stepped = (minute: number, offsetS: number) =>
    row("clock_stepped", at(minute), { detail: { offset_s: String(offsetS), source: "server" } });

  it("★ tonight: a clock set 23 h ahead is red, at any hour — then put back, plain", () => {
    const out = present([stepped(5, 82_800), stepped(6, 0)]);
    expect(story(out)).toEqual([`${clockSetText(82_800)} [red]`, HISTORY_TEXT.clockRight]);
    expect(clockSetText(82_800)).toBe("Mac's clock set 23 h ahead");
    expect(clockSetText(-1800)).toBe("Mac's clock set 30 m behind");
  });

  it("a wobble inside a minute is the clock being right, never red", () => {
    expect(story(present([stepped(5, 45)]))).toEqual([HISTORY_TEXT.clockRight]);
  });

  it("“Set time automatically” turned off is red", () => {
    expect(story(present([row("network_time_off", at(5))]))).toEqual([
      `${HISTORY_TEXT.networkTimeOff} [red]`,
    ]);
  });

  it("a time zone change is red, and names the place", () => {
    const out = present([
      row("timezone_changed", at(5), {
        detail: { from: "America/New_York", to: "America/Los_Angeles" },
      }),
    ]);
    expect(story(out)).toEqual(["Time zone changed to Los Angeles [red]"]);
    expect(zoneName("Pacific/Honolulu")).toBe("Honolulu");
  });

  const corrected = (minute: number, offsetS: number) =>
    row("clock_corrected", at(minute), {
      detail: { method: "network_time_on", offset_s: offsetS },
    });

  it("★ Ivy's install: the clock fixed before the enforcer measured it — the fix is the red row", () => {
    expect(story(present([row("network_time_off", at(5)), corrected(5, 79_196)]))).toEqual([
      `${HISTORY_TEXT.networkTimeOff} [red]`,
      `${clockWasText(79_196)} [red]`,
    ]);
    expect(clockWasText(79_196)).toBe("Mac's clock was 22 h ahead — put right");
  });

  it("a fix after a red clock row is the same incident: plain", () => {
    expect(story(present([stepped(5, 3600), corrected(6, 3600)]))).toEqual([
      `${clockSetText(3600)} [red]`,
      HISTORY_TEXT.clockPutRight,
    ]);
  });

  it("an agent clock_stepped with no offset (none was ever sent) is skipped, not misread", () => {
    expect(present([row("clock_stepped", at(5))])).toEqual([]);
  });
});

describe("bedtimeUse — in use when it should have been off (ADR 0015)", () => {
  /** Enforced 20–30 with a 5-minute grace: the shutdown is due at minute 25. */
  const shutdownRule =
    (action = "shutdown"): RestrictionLookup =>
    (_d, when) => {
      const minute = (when.getTime() - at(0).getTime()) / 60_000;
      if (minute >= 20 && minute < 30)
        return {
          phase: "enforced",
          windowId: "w",
          label: "Weekdays",
          enforcedFrom: at(20).getTime(),
          action,
          graceS: 300,
        };
      return null;
    };
  const span = (from: number, to: number | null) => ({
    deviceId: DEVICE,
    startedAt: at(from),
    endedAt: to === null ? null : at(to),
  });

  it("★ unlocked after the shutdown was due (plus slack): one red row, at the first moment", () => {
    const rows = bedtimeUse([span(15, 29)], shutdownRule(), at(59));
    expect(rows.map((r) => r.occurredAt)).toEqual([at(27)]);
    expect(story(present(rows))).toEqual([`${usedInBedtime("Weekdays", "shutdown")} [red]`]);
    expect(usedInBedtime("Weekdays", "shutdown")).toBe(
      "Mac in use during Weekdays's bedtime — it should have been off",
    );
  });

  it("★ inside the grace she may unlock — the ladder working, not a bypass", () => {
    expect(bedtimeUse([span(20, 26)], shutdownRule(), at(59))).toEqual([]);
  });

  it("a lock rule counts from the lock itself", () => {
    const rows = bedtimeUse([span(21, 29)], shutdownRule("lock"), at(59));
    expect(rows.map((r) => r.occurredAt)).toEqual([at(22)]);
    expect(rows[0]?.summary).toBe(
      "Mac in use during Weekdays's bedtime — it should have been locked",
    );
  });

  it("warn-only rules never flag use — nothing was supposed to stop her", () => {
    expect(bedtimeUse([span(15, 29)], shutdownRule("warn_only"), at(59))).toEqual([]);
  });

  it("one row per rule per night, however many spans", () => {
    expect(bedtimeUse([span(26, 27), span(28, 29)], shutdownRule(), at(59))).toHaveLength(1);
  });

  it("an open span runs to now", () => {
    expect(bedtimeUse([span(24, null)], shutdownRule(), at(28))).toHaveLength(1);
  });
});

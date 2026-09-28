import { describe, expect, it } from "vitest";
import {
  type DeviceContext,
  HISTORY_TEXT,
  type PolicyReason,
  presentHistory,
  type RawHistoryRow,
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
const started = (minute: number, second = 0) => row("agent_started", at(minute, second));
/** The SERVER's row: the Mac's uptime dropped between two check-ins. */
const poweredOn = (minute: number) =>
  row("power_on", at(minute), { summary: "Mac turned on", detail: { source: "server" } });
const applied = (minute: number, version: number) =>
  row("policy_applied", at(minute), { policyVersion: version });

const known = (extra: Partial<DeviceContext> = {}) =>
  new Map<string, DeviceContext>([
    [DEVICE, { hasHistoryBefore: true, versionBefore: null, removed: false, ...extra }],
  ]);

/** Oldest first, which is how a parent reads a story; the function returns newest first. */
const story = (rows: ReturnType<typeof presentHistory>) =>
  rows.map((r) => `${r.summary}${r.tone === "alarm" ? " [red]" : ""}`).reverse();

describe("presentHistory — power", () => {
  it("★ a bedtime shutdown and the server's power-on read as two red lines, not six raw ones", () => {
    const rows = [
      lock(20),
      shutdown(21),
      stopping(21),
      stopping(21, 1),
      poweredOn(40),
      started(40, 20),
    ];
    expect(story(presentHistory(rows, known()))).toEqual([
      "Enforced: lock",
      `${HISTORY_TEXT.shutDownAtBedtime} [red]`,
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
  });

  it("★ a shutdown by hand is 'Mac shut down' — once the power-on proves it", () => {
    const rows = [stopping(10), stopping(10, 1), poweredOn(40), started(40, 15)];
    expect(story(presentHistory(rows, known()))).toEqual([
      `${HISTORY_TEXT.shutDown} [red]`,
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
  });

  it("★ a stop and a start with no power-on between is a restart, never a power event", () => {
    const rows = [stopping(10), stopping(10, 1), started(11)];
    const out = presentHistory(rows, known());
    expect(story(out)).toEqual([HISTORY_TEXT.restarted]);
    expect(out.every((r) => r.tone === "plain")).toBe(true);
  });

  it("a power-on with no stop before it (a power cut) is still 'Mac turned on'", () => {
    expect(story(presentHistory([lock(10), poweredOn(30), started(30, 10)], known()))).toEqual([
      "Enforced: lock",
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
  });

  it("★ older history: the launch after a BEDTIME shutdown is the Mac coming back on", () => {
    // Recorded before the server wrote power-on rows. The enforcer ordered the
    // shutdown itself, so its next launch can only be the boot.
    const rows = [shutdown(21, 5), stopping(21, 5), stopping(21, 5), started(21, 50)];
    expect(story(presentHistory(rows, known()))).toEqual([
      `${HISTORY_TEXT.shutDownAtBedtime} [red]`,
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
  });

  it("★ a stop nothing explains yet is plain 'stopped', not a guessed shutdown", () => {
    const out = presentHistory([stopping(21), stopping(21, 1)], known());
    expect(story(out)).toEqual([HISTORY_TEXT.stopped]);
    expect(out.some((r) => r.tone === "alarm")).toBe(false);
  });

  it("a Mac still off after a bedtime shutdown shows the shutdown, red", () => {
    expect(story(presentHistory([shutdown(21), stopping(21)], known()))).toEqual([
      `${HISTORY_TEXT.shutDownAtBedtime} [red]`,
    ]);
  });

  it("a removed device's last stop is its uninstall", () => {
    expect(
      story(presentHistory([stopping(21), stopping(21, 1)], known({ removed: true }))),
    ).toEqual([HISTORY_TEXT.removed]);
  });

  it("★ the first start a device ever reports is the install, then registration", () => {
    const rows = [started(1), row("agent_started", at(2), { detail: { enrolled: true } })];
    const out = presentHistory(rows);
    expect(story(out)).toEqual([HISTORY_TEXT.started, HISTORY_TEXT.registered]);
    expect(out.some((r) => r.tone === "alarm")).toBe(false);
  });

  it("★ a launch long after a power-on is a restart, not a second power-on", () => {
    const rows = [poweredOn(0), started(0, 20), started(30)];
    expect(story(presentHistory(rows, known()))).toEqual([
      `${HISTORY_TEXT.turnedOn} [red]`,
      HISTORY_TEXT.restarted,
    ]);
  });

  it("a lock in the same second as the shutdown does not split the stop, and reads first", () => {
    const rows = [shutdown(21), lock(21), stopping(21), poweredOn(25)];
    expect(story(presentHistory(rows, known()))).toEqual([
      "Enforced: lock",
      `${HISTORY_TEXT.shutDownAtBedtime} [red]`,
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
  });

  it("two stops far apart with nothing between are two separate stops", () => {
    const out = presentHistory([stopping(10), stopping(30)], known());
    expect(out.filter((r) => r.kind === "agent_stopped")).toHaveLength(2);
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
    const out = story(presentHistory(rows, known(), reasons));
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

  it("★ hides the nightly refresh — nothing changed for the parent", () => {
    expect(presentHistory([applied(3, 3)], known(), reasons)).toEqual([]);
  });

  it("★ hides the same version re-applied after a restart", () => {
    const rows = [applied(1, 2), started(3), applied(3, 2)];
    expect(story(presentHistory(rows, known(), reasons))).toEqual([
      HISTORY_TEXT.rules.schedule_edit,
      HISTORY_TEXT.restarted,
    ]);
  });

  it("…including a re-apply of the version from before the window", () => {
    expect(presentHistory([applied(1, 2)], known({ versionBefore: 2 }), reasons)).toEqual([]);
  });
});

describe("presentHistory — shape", () => {
  it("returns newest first, across devices", () => {
    const other = { ...started(30), deviceId: "d2" };
    const out = presentHistory([started(10), other]);
    expect(out.map((r) => r.at)).toEqual([at(30).toISOString(), at(10).toISOString()]);
  });

  it("passes other rows through unchanged and plain", () => {
    expect(presentHistory([lock(10)], known())).toEqual([
      {
        at: at(10).toISOString(),
        kind: "action_taken",
        summary: "Enforced: lock",
        deviceId: DEVICE,
        policyVersion: null,
        tone: "plain",
      },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  type DeviceContext,
  HISTORY_TEXT,
  type PolicyReason,
  presentHistory,
  type RawHistoryRow,
} from "./history.js";

const DEVICE = "d1";
const BOOT_A = "boot-a";
const BOOT_B = "boot-b";

/** Minutes past noon on the test day, as a Date. */
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 8, 28, 16, minute, second));

function row(
  kind: string,
  minute: number,
  bootId: string | null,
  extra: Partial<RawHistoryRow> = {},
): RawHistoryRow {
  return {
    deviceId: DEVICE,
    kind,
    summary: `raw ${kind}`,
    occurredAt: at(minute, extra.occurredAt ? 0 : 0),
    policyVersion: null,
    detail: {},
    bootId,
    ...extra,
  };
}

const stopping = (minute: number, boot: string | null, second = 0) =>
  row("agent_stopping", minute, boot, { occurredAt: at(minute, second) });
const shutdown = (minute: number, boot: string | null) =>
  row("action_taken", minute, boot, { detail: { action: "shutdown" } });
const lock = (minute: number, boot: string | null) =>
  row("action_taken", minute, boot, { detail: { action: "lock" }, summary: "Enforced: lock" });
const started = (minute: number, boot: string | null) => row("agent_started", minute, boot);
const applied = (minute: number, boot: string | null, version: number) =>
  row("policy_applied", minute, boot, { policyVersion: version });

const seen = (bootBefore: string | null, extra: Partial<DeviceContext> = {}) =>
  new Map<string, DeviceContext>([
    [
      DEVICE,
      {
        bootBefore,
        hasHistoryBefore: bootBefore !== null,
        versionBefore: null,
        removed: false,
        ...extra,
      },
    ],
  ]);

/** Oldest first, which is how a parent reads a story; the function returns newest first. */
const story = (rows: ReturnType<typeof presentHistory>) =>
  rows.map((r) => `${r.summary}${r.tone === "alarm" ? " [red]" : ""}`).reverse();

describe("presentHistory — power", () => {
  it("★ a bedtime shutdown and the next boot read as two red lines, not five raw ones", () => {
    const rows = [
      lock(20, BOOT_A),
      shutdown(21, BOOT_A),
      stopping(21, BOOT_A),
      stopping(21, BOOT_A, 1),
      started(22, BOOT_B),
    ];
    expect(story(presentHistory(rows, seen(BOOT_A)))).toEqual([
      "Enforced: lock",
      `${HISTORY_TEXT.shutDownAtBedtime} [red]`,
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
  });

  it("a shutdown the child or parent did by hand is 'Mac shut down', still red", () => {
    const rows = [stopping(10, BOOT_A), stopping(10, BOOT_A, 1), started(40, BOOT_B)];
    expect(story(presentHistory(rows, seen(BOOT_A)))).toEqual([
      `${HISTORY_TEXT.shutDown} [red]`,
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
  });

  it("★ a stop and start on the SAME boot is a restart, never a power event", () => {
    const rows = [stopping(10, BOOT_A), stopping(10, BOOT_A, 1), started(11, BOOT_A)];
    const out = presentHistory(rows, seen(BOOT_A));
    expect(story(out)).toEqual([HISTORY_TEXT.restarted]);
    expect(out.every((r) => r.tone === "plain")).toBe(true);
  });

  it("★ a new boot with no clean stop (power cut) is still 'Mac turned on'", () => {
    const rows = [lock(10, BOOT_A), started(30, BOOT_B)];
    expect(story(presentHistory(rows, seen(BOOT_A)))).toEqual([
      "Enforced: lock",
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
  });

  it("a Mac that is still off shows the shutdown with nothing after it", () => {
    const rows = [shutdown(21, BOOT_A), stopping(21, BOOT_A)];
    expect(story(presentHistory(rows, seen(BOOT_A)))).toEqual([
      `${HISTORY_TEXT.shutDownAtBedtime} [red]`,
    ]);
  });

  it("a removed device's last stop is its uninstall, not a shutdown", () => {
    const rows = [stopping(21, BOOT_A), stopping(21, BOOT_A, 1)];
    expect(story(presentHistory(rows, seen(BOOT_A, { removed: true })))).toEqual([
      HISTORY_TEXT.removed,
    ]);
  });

  it("★ the first start a device ever reports is the install, not a power-on", () => {
    const rows = [
      started(1, BOOT_A),
      row("agent_started", 2, BOOT_A, { detail: { enrolled: true } }),
    ];
    const out = presentHistory(rows);
    expect(story(out)).toEqual([HISTORY_TEXT.started, HISTORY_TEXT.registered]);
    expect(out.some((r) => r.tone === "alarm")).toBe(false);
  });

  it("★ an unknown boot is never claimed as a power cycle", () => {
    const rows = [stopping(10, null), started(40, null)];
    const out = presentHistory(rows, seen(BOOT_A));
    expect(out.some((r) => r.kind === "power_on")).toBe(false);
  });

  it("the boot BEFORE the window decides whether its first start is a power-on", () => {
    expect(story(presentHistory([started(5, BOOT_B)], seen(BOOT_A)))).toEqual([
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
    expect(story(presentHistory([started(5, BOOT_A)], seen(BOOT_A)))).toEqual([
      HISTORY_TEXT.restarted,
    ]);
  });

  it("a lock inside the same second as the shutdown does not split the stop", () => {
    const rows = [
      shutdown(21, BOOT_A),
      lock(21, BOOT_A),
      stopping(21, BOOT_A),
      started(25, BOOT_B),
    ];
    expect(story(presentHistory(rows, seen(BOOT_A)))).toEqual([
      "Enforced: lock",
      `${HISTORY_TEXT.shutDownAtBedtime} [red]`,
      `${HISTORY_TEXT.turnedOn} [red]`,
    ]);
  });

  it("two separate stops without a start between them are two shutdowns", () => {
    const rows = [stopping(10, BOOT_A), stopping(30, BOOT_A)];
    expect(presentHistory(rows, seen(BOOT_A)).filter((r) => r.kind === "power_off")).toHaveLength(
      2,
    );
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
      applied(1, BOOT_A, 1),
      applied(2, BOOT_A, 2),
      applied(4, BOOT_A, 4),
      applied(5, BOOT_A, 5),
      applied(6, BOOT_A, 6),
      applied(7, BOOT_A, 9),
    ];
    const out = story(presentHistory(rows, seen(BOOT_A), reasons));
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
    expect(presentHistory([applied(3, BOOT_A, 3)], seen(BOOT_A), reasons)).toEqual([]);
  });

  it("★ hides the same version re-applied after a restart", () => {
    const rows = [applied(1, BOOT_A, 2), started(3, BOOT_A), applied(3, BOOT_A, 2)];
    expect(story(presentHistory(rows, seen(BOOT_A), reasons))).toEqual([
      HISTORY_TEXT.rules.schedule_edit,
      HISTORY_TEXT.restarted,
    ]);
  });

  it("…including a re-apply of the version from before the window", () => {
    const ctx = seen(BOOT_A, { versionBefore: 2 });
    expect(presentHistory([applied(1, BOOT_A, 2)], ctx, reasons)).toEqual([]);
  });
});

describe("presentHistory — shape", () => {
  it("returns newest first, across devices", () => {
    const other = { ...started(30, "x"), deviceId: "d2" };
    const out = presentHistory([started(10, BOOT_A), other]);
    expect(out.map((r) => r.at)).toEqual([at(30).toISOString(), at(10).toISOString()]);
  });

  it("passes other rows through unchanged and plain", () => {
    const out = presentHistory([lock(10, BOOT_A)], seen(BOOT_A));
    expect(out).toEqual([
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

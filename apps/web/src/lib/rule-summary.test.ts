import { describe, expect, it } from "vitest";
import {
  compiledWindows,
  describeDays,
  neverShutsDown,
  summarise,
  windowMinutes,
} from "./rule-summary.js";

const window = (from: string, until: string, action = "shutdown", grace = 300) => ({
  days: ["sun"],
  restricted_from: from,
  restricted_until: until,
  action,
  shutdown_grace_s: grace,
});

describe("windowMinutes", () => {
  it("measures a same-day window", () => {
    expect(windowMinutes("02:45", "02:50")).toBe(5);
  });

  it("crosses midnight when the end is not after the start", () => {
    expect(windowMinutes("21:30", "07:00")).toBe(570);
  });
});

describe("neverShutsDown — the second observed lock's lesson", () => {
  it("★ flags the 5-minute window that ran against a 5-minute grace", () => {
    // 02:45 → 02:50 with the default grace: locked at 02:45:32, still only
    // 240 s in at the last tick inside the window. It could never escalate.
    expect(neverShutsDown(window("02:45", "02:50"))).toBe(true);
  });

  it("clears the 10-minute window that did reach the DEV_ENFORCEMENT line", () => {
    expect(neverShutsDown(window("02:57", "03:07"))).toBe(false);
  });

  it("never applies to a lock-only window", () => {
    expect(neverShutsDown(window("02:45", "02:50", "lock"))).toBe(false);
  });
});

describe("summaries", () => {
  it("reads like a sentence", () => {
    expect(summarise(window("21:30", "07:00"))).toBe(
      "Sun · 21:30 → 07:00 · Lock, then shut down after 5 min",
    );
  });

  it("orders nights Monday first and names a full week", () => {
    expect(describeDays(["thu", "mon"])).toBe("Mon Thu");
    expect(describeDays(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).toBe("Every night");
  });
});

describe("compiledWindows", () => {
  it("reads the policy document's shape, action_options included", () => {
    const doc = {
      schedule: {
        kind: "windows",
        windows: [
          {
            label: "School nights",
            days: ["sun"],
            restricted_from: "21:30",
            restricted_until: "07:00",
            action: "shutdown",
            action_options: { shutdown_grace_s: 600, escalate_after_failures: 3 },
          },
        ],
      },
    };
    expect(compiledWindows(doc)).toEqual([
      {
        label: "School nights",
        days: ["sun"],
        restricted_from: "21:30",
        restricted_until: "07:00",
        action: "shutdown",
        shutdown_grace_s: 600,
      },
    ]);
  });

  it("returns null rather than throwing on a document it cannot read", () => {
    expect(compiledWindows(null)).toBeNull();
    expect(compiledWindows({ schedule: "?" })).toBeNull();
  });
});

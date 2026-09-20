import { describe, expect, it } from "vitest";
import {
  ACTIVE_TIME_EXPLANATION,
  ACTIVE_TIME_LABEL,
  DECOMMISSION,
  grantWillApplyWhenReconnected,
  type HealthState,
  healthPhrasing,
  LATE_GRANT_DOES_NOT_UNLOCK,
  lateGrantDoesNotUnlock,
  REVOKE,
  shadowModeNotEnforcing,
} from "./wording.js";

/**
 * The four load-bearing wordings, pinned.
 *
 * These read like copy tests and are not. Each assertion is a behaviour the
 * spec requires the UI to communicate, and in every case the natural, tidier
 * phrasing states something false. A failing test here means a parent is
 * about to misunderstand what their child's Mac is doing.
 */
const subject = { childName: "Lucy", deviceLabel: "Lucy's Mac" };

describe("1. the still-enforcing banner (§4.6)", () => {
  // ★ "The natural parental fear on seeing 'offline' is 'so the rules aren't
  // working', which is the exact opposite of the truth."
  it("★ silence says the device is STILL ENFORCING", () => {
    for (const state of ["UNEXPECTED_SILENCE", "SILENT_TOO_LONG"] as HealthState[]) {
      const phrasing = healthPhrasing(state, subject, {
        silentFor: "2 days",
        lastPolicyDay: "Tuesday",
      });
      expect(phrasing.headline).toContain("hasn't checked in for 2 days");
      expect(phrasing.reassurance).toBe("It is still enforcing the rules from Tuesday.");
    }
  });

  it("names the day the rules came from, not the day it went quiet", () => {
    const phrasing = healthPhrasing("UNEXPECTED_SILENCE", subject, {
      silentFor: "14 minutes",
      lastPolicyDay: "Tuesday",
    });
    expect(phrasing.reassurance).toContain("Tuesday");
    expect(phrasing.reassurance).not.toContain("14 minutes");
  });

  it("degrades to a truthful phrase when the day is unknown", () => {
    const phrasing = healthPhrasing("UNEXPECTED_SILENCE", subject, { silentFor: "an hour" });
    expect(phrasing.reassurance).toBe("It is still enforcing the rules it already has.");
  });

  // ★ The one state where reassurance would be a lie.
  it("★ DEGRADED says it is NOT enforcing, and offers no reassurance", () => {
    const phrasing = healthPhrasing("DEGRADED", subject);
    expect(phrasing.headline).toBe(
      "Lucy's Mac is not enforcing — its rules are missing or unreadable.",
    );
    expect(phrasing.reassurance).toBeNull();
    expect(phrasing.tone).toBe("alarm");
  });

  it("★ no state except DEGRADED ever claims enforcement stopped", () => {
    const states: HealthState[] = [
      "HEALTHY",
      "EXPECTED_OFFLINE",
      "UNEXPECTED_SILENCE",
      "SILENT_TOO_LONG",
    ];
    for (const state of states) {
      const phrasing = healthPhrasing(state, subject);
      expect(phrasing.headline).not.toContain("not enforcing");
    }
  });

  it("EXPECTED_OFFLINE is not dressed as a problem", () => {
    // A Mac that is off overnight because it is meant to be off is the system
    // working. Colouring that amber trains the parent to ignore amber.
    expect(healthPhrasing("EXPECTED_OFFLINE", subject).tone).toBe("ok");
  });

  it("every health state has phrasing — no silent fallthrough", () => {
    const states: HealthState[] = [
      "UNENROLLED",
      "HEALTHY",
      "DEGRADED",
      "EXPECTED_OFFLINE",
      "UNEXPECTED_SILENCE",
      "SILENT_TOO_LONG",
    ];
    for (const state of states) {
      expect(healthPhrasing(state, subject).headline.length).toBeGreaterThan(0);
    }
  });
});

describe("2. the no-unlock sentence (§3.5)", () => {
  // ★ Both clauses do different jobs. The first sets the expectation, the
  // second kills the belief that the Mac is now open.
  it("★ carries both the ~5 seconds AND the won't-wake-it clause", () => {
    expect(LATE_GRANT_DOES_NOT_UNLOCK).toContain("about 5 seconds");
    expect(LATE_GRANT_DOES_NOT_UNLOCK).toContain("won't wake the Mac for her");
  });

  it("★ never implies the grant unlocks anything", () => {
    for (const text of [LATE_GRANT_DOES_NOT_UNLOCK, lateGrantDoesNotUnlock(subject)]) {
      expect(text.toLowerCase()).not.toContain("unlock");
      expect(text.toLowerCase()).not.toContain("wakes");
    }
  });

  it("the named form says the same thing about the same child", () => {
    const text = lateGrantDoesNotUnlock(subject);
    expect(text).toContain("Lucy will be able to log back in");
    expect(text).toContain("won't wake the Mac for her");
  });

  // ⚠️ D.5 — the sentence ENDS. There is no offline code to read out.
  it("★ the offline sentence offers no code and no workaround", () => {
    const text = grantWillApplyWhenReconnected(subject, "14 minutes");
    expect(text).toBe(
      "Lucy's Mac hasn't checked in for 14 minutes. This grant will apply when it reconnects.",
    );
    expect(text.toLowerCase()).not.toContain("code");
  });
});

describe("3. Revoke vs Decommission (§5.5)", () => {
  // ★ They look alike and behave oppositely.
  it("★ Revoke keeps enforcing; Decommission stops everything", () => {
    expect(REVOKE.stopsEnforcement).toBe(false);
    expect(REVOKE.description).toContain("keeps enforcing bedtime");

    expect(DECOMMISSION.stopsEnforcement).toBe(true);
    expect(DECOMMISSION.description).toContain("stops enforcing anything");
  });

  it("each says when to use it, because the labels alone do not", () => {
    expect(REVOKE.useWhen).toContain("credential leaked");
    expect(DECOMMISSION.useWhen).toContain("leaving the house");
  });

  // ⚠️ "the UI must make these typed-confirmation actions".
  it("★ both are typed-confirmation actions", () => {
    expect(REVOKE.confirmWord).toBe("REVOKE");
    expect(DECOMMISSION.confirmWord).toBe("DECOMMISSION");
  });

  it("the two confirm words are not interchangeable", () => {
    // Typing one must not satisfy the other; that is the entire point of
    // making them typed.
    expect(REVOKE.confirmWord).not.toBe(DECOMMISSION.confirmWord);
  });
});

describe("shadow mode (§6.5)", () => {
  // ★ Intended non-enforcement is still non-enforcement, and it is MORE
  // tempting to phrase gently than a fault is.
  it("★ says NOT enforcing, in those words", () => {
    const text = shadowModeNotEnforcing(subject, "tomorrow at 09:00");
    expect(text).toContain("NOT enforcing");
    expect(text).toContain("Lucy's Mac");
  });

  it("★ says the window ends, so it does not read as an outage", () => {
    expect(shadowModeNotEnforcing(subject, "tomorrow")).toContain("enforcing again");
    // And still says so when the deadline is unknown.
    expect(shadowModeNotEnforcing(subject)).toContain("enforcing again");
  });

  it("★ never softens it into 'checking' alone", () => {
    const text = shadowModeNotEnforcing(subject).toLowerCase();
    expect(text).toContain("not enforcing");
  });
});

describe("4. the active_s label (§5.8)", () => {
  // ★ "Screen time" reads as "time the Mac was switched on". It is not that.
  it("★ explains that it is use, not uptime", () => {
    expect(ACTIVE_TIME_LABEL).toBe("Active time");
    expect(ACTIVE_TIME_EXPLANATION).toBe(
      "Minutes she was actually using the Mac, not minutes it was switched on.",
    );
  });

  it("★ the label is not 'screen time'", () => {
    expect(ACTIVE_TIME_LABEL.toLowerCase()).not.toContain("screen time");
  });
});

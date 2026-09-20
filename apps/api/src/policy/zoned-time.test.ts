import { describe, expect, it } from "vitest";
import { addDays, dateInZone, WEEKDAYS, weekdayOf, zonedToInstant } from "./zoned-time.js";

const NY = "America/New_York";

describe("zonedToInstant", () => {
  it("resolves standard time (EST, UTC-5)", () => {
    expect(zonedToInstant("2026-12-25", "07:00", NY).toISOString()).toBe(
      "2026-12-25T12:00:00.000Z",
    );
  });

  it("resolves daylight time (EDT, UTC-4)", () => {
    expect(zonedToInstant("2026-07-04", "07:00", NY).toISOString()).toBe(
      "2026-07-04T11:00:00.000Z",
    );
  });

  it("handles a zone on the other side of UTC", () => {
    expect(zonedToInstant("2026-12-25", "07:00", "Asia/Taipei").toISOString()).toBe(
      "2026-12-24T23:00:00.000Z",
    );
  });

  it("treats UTC as a no-op", () => {
    expect(zonedToInstant("2026-12-25", "07:00", "UTC").toISOString()).toBe(
      "2026-12-25T07:00:00.000Z",
    );
  });

  it("crosses the spring-forward boundary correctly on either side", () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT.
    expect(zonedToInstant("2026-03-08", "01:00", NY).toISOString()).toBe(
      "2026-03-08T06:00:00.000Z",
    );
    expect(zonedToInstant("2026-03-08", "03:00", NY).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
  });

  it("crosses the fall-back boundary correctly on either side", () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST.
    expect(zonedToInstant("2026-11-01", "00:30", NY).toISOString()).toBe(
      "2026-11-01T04:30:00.000Z",
    );
    expect(zonedToInstant("2026-11-01", "03:00", NY).toISOString()).toBe(
      "2026-11-01T08:00:00.000Z",
    );
  });

  /**
   * ⚠️ These two assert the documented DIVERGENCE from §3.2's rules, not
   * conformance to them. §3.2 says a skipped hour snaps FORWARD and an
   * ambiguous hour resolves toward enforcement (the later occurrence). This
   * resolver does the opposite in both cases — which is safe here, because
   * both make a relaxation expire EARLIER, and stricter is the direction §4.6
   * wants ambiguity to fall. The agent's resolver is phase 3's and must do it
   * the other way. Pinned so a change is visible rather than silent.
   */
  describe("DST edges — deliberately stricter than the agent's rules", () => {
    it("a time inside the spring-forward gap lands BEFORE the gap", () => {
      // 02:30 does not exist on this date. §3.2 would snap to 03:00 EDT
      // (07:00Z); we land on 01:30 EST (06:30Z) — 90 minutes earlier.
      expect(zonedToInstant("2026-03-08", "02:30", NY).toISOString()).toBe(
        "2026-03-08T06:30:00.000Z",
      );
    });

    it("a time in the ambiguous hour takes the EARLIER occurrence", () => {
      // 01:30 happens twice. We take 01:30 EDT (05:30Z), not 01:30 EST (06:30Z).
      expect(zonedToInstant("2026-11-01", "01:30", NY).toISOString()).toBe(
        "2026-11-01T05:30:00.000Z",
      );
    });
  });
});

describe("addDays", () => {
  it("adds within a month", () => {
    expect(addDays("2026-09-20", 21)).toBe("2026-10-11");
  });

  it("crosses a year boundary", () => {
    expect(addDays("2026-12-25", 10)).toBe("2027-01-04");
  });

  it("handles a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("subtracts with a negative delta", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("dateInZone", () => {
  it("reports the local date, not the UTC one", () => {
    // 2026-12-25T02:00Z is still Christmas Eve in New York.
    expect(dateInZone(new Date("2026-12-25T02:00:00Z"), NY)).toBe("2026-12-24");
    expect(dateInZone(new Date("2026-12-25T02:00:00Z"), "UTC")).toBe("2026-12-25");
  });
});

describe("weekdayOf", () => {
  it("is Monday-indexed, matching the contract enum", () => {
    expect(weekdayOf("2026-09-21")).toBe("mon");
    expect(weekdayOf("2026-09-20")).toBe("sun");
    expect(weekdayOf("2026-09-26")).toBe("sat");
  });

  it("agrees with WEEKDAYS across a full week", () => {
    const week = Array.from({ length: 7 }, (_, i) => weekdayOf(addDays("2026-09-21", i)));
    expect(week).toEqual([...WEEKDAYS]);
  });
});

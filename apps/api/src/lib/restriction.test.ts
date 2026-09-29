import { describe, expect, it } from "vitest";
import { type RestrictionDocument, restrictionAt } from "./restriction.js";

const NY = "America/New_York";
/** A New York wall-clock time as an instant (EDT, UTC-4, in late September). */
const ny = (date: string, time: string) => new Date(`${date}T${time}:00-04:00`);

// 2026-09-28 is a Monday.
const IVY: RestrictionDocument = {
  timezone: NY,
  schedule: {
    windows: [
      {
        id: "weekdays",
        label: "Weekdays",
        days: ["sun", "mon", "tue", "wed", "thu"],
        restricted_from: "23:45",
        restricted_until: "23:55",
        watch_until: "07:00",
      },
      {
        id: "weekends",
        label: "Weekends",
        days: ["fri", "sat"],
        restricted_from: "00:45",
        restricted_until: "00:55",
        watch_until: "07:00",
      },
    ],
  },
  overrides: [],
};

const phase = (doc: RestrictionDocument, at: Date) => {
  const result = restrictionAt(doc, at);
  return result ? `${result.phase}:${result.label}` : "free";
};

describe("restrictionAt — enforced vs watched (ADR 0014)", () => {
  it("★ From→Until is enforced; Until→Watch until is watched; after that, free", () => {
    expect(phase(IVY, ny("2026-09-28", "23:40"))).toBe("free");
    expect(phase(IVY, ny("2026-09-28", "23:50"))).toBe("enforced:Weekdays");
    expect(phase(IVY, ny("2026-09-28", "23:55"))).toBe("watch:Weekdays"); // half-open end
    expect(phase(IVY, ny("2026-09-29", "01:12"))).toBe("watch:Weekdays"); // yesterday's window
    expect(phase(IVY, ny("2026-09-29", "06:59"))).toBe("watch:Weekdays");
    expect(phase(IVY, ny("2026-09-29", "07:00"))).toBe("free");
    expect(phase(IVY, ny("2026-09-29", "12:00"))).toBe("free");
  });

  it("a window that starts after midnight belongs to the day it starts", () => {
    // "fri 00:45" is early Friday — late Thursday night.
    expect(phase(IVY, ny("2026-10-02", "00:50"))).toBe("enforced:Weekends");
    expect(phase(IVY, ny("2026-10-02", "03:00"))).toBe("watch:Weekends");
  });

  it("★ with no watch time there is no watch period — exactly as before", () => {
    const doc: RestrictionDocument = {
      timezone: NY,
      schedule: {
        windows: [
          {
            id: "w",
            label: "Bedtime",
            days: ["mon"],
            restricted_from: "23:45",
            restricted_until: "23:55",
          },
        ],
      },
    };
    expect(phase(doc, ny("2026-09-29", "01:00"))).toBe("free");
  });

  it("a window wrapping midnight is enforced through the night", () => {
    const doc: RestrictionDocument = {
      timezone: NY,
      schedule: {
        windows: [
          {
            id: "w",
            label: "Bedtime",
            days: ["mon"],
            restricted_from: "21:30",
            restricted_until: "07:00",
          },
        ],
      },
    };
    expect(phase(doc, ny("2026-09-29", "02:00"))).toBe("enforced:Bedtime");
  });
});

describe("restrictionAt — overrides, as the agent applies them", () => {
  const withOverride = (override: Record<string, unknown>): RestrictionDocument => ({
    ...IVY,
    overrides: [{ expires_at: "2026-09-30T00:00:00Z", effective_date: "2026-09-28", ...override }],
  });

  it("★ 'No bedtime tonight' clears the night — and its watch period", () => {
    const doc = withOverride({ type: "suspend", window_id: null });
    expect(phase(doc, ny("2026-09-28", "23:50"))).toBe("free");
    expect(phase(doc, ny("2026-09-29", "01:12"))).toBe("free");
    // The next night is untouched.
    expect(phase(doc, ny("2026-09-29", "23:50"))).toBe("enforced:Weekdays");
  });

  it("extra time moves the start later, never the end — so watching still starts at Until", () => {
    const doc = withOverride({ type: "extend", minutes: 5, window_id: "weekdays" });
    expect(phase(doc, ny("2026-09-28", "23:47"))).toBe("free");
    expect(phase(doc, ny("2026-09-28", "23:52"))).toBe("enforced:Weekdays");
    expect(phase(doc, ny("2026-09-28", "23:56"))).toBe("watch:Weekdays");
  });

  it("an expired override relaxes nothing", () => {
    const doc = withOverride({ type: "suspend", expires_at: "2026-09-28T12:00:00Z" });
    expect(phase(doc, ny("2026-09-28", "23:50"))).toBe("enforced:Weekdays");
  });

  it("an override for another window, or another day, relaxes nothing here", () => {
    expect(
      phase(withOverride({ type: "suspend", window_id: "weekends" }), ny("2026-09-28", "23:50")),
    ).toBe("enforced:Weekdays");
    expect(
      phase(
        withOverride({ type: "suspend", effective_date: "2026-09-27" }),
        ny("2026-09-28", "23:50"),
      ),
    ).toBe("enforced:Weekdays");
  });
});

describe("restrictionAt — time", () => {
  it("★ reads the rules' timezone, not the server's", () => {
    const utc: RestrictionDocument = { ...IVY, timezone: "UTC" };
    // 23:50 in New York is 03:50 UTC — inside the UTC watch period, not the NY enforcement.
    expect(phase(utc, ny("2026-09-28", "23:50"))).toBe("watch:Weekdays");
  });

  it("the fall-back night still covers the whole watch period", () => {
    // 2026-11-01: 02:00 EDT becomes 01:00 EST. Saturday night's window.
    const doc: RestrictionDocument = {
      timezone: NY,
      schedule: {
        windows: [
          {
            id: "w",
            label: "Bedtime",
            days: ["sat"],
            restricted_from: "23:00",
            restricted_until: "23:30",
            watch_until: "07:00",
          },
        ],
      },
    };
    expect(phase(doc, new Date("2026-11-01T06:30:00Z"))).toBe("watch:Bedtime"); // 01:30 EST
    expect(phase(doc, new Date("2026-11-01T11:30:00Z"))).toBe("watch:Bedtime"); // 06:30 EST
    expect(phase(doc, new Date("2026-11-01T12:30:00Z"))).toBe("free"); // 07:30 EST
  });
});

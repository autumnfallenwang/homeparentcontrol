import { describe, expect, it } from "vitest";
import { appName, humanDuration, humanMinutes, weekdayOf } from "./format.js";

describe("humanDuration", () => {
  it("reads the way a person would say it", () => {
    expect(humanDuration(10)).toBe("just now");
    expect(humanDuration(120)).toBe("2 minutes");
    expect(humanDuration(60)).toBe("1 minute");
    expect(humanDuration(3_600)).toBe("1 hour");
    expect(humanDuration(2 * 86_400)).toBe("2 days");
  });

  // ⚠️ §4.6's sentence interpolates this. "hasn't checked in for null" is
  // the failure, and it is the kind that ships.
  it("★ never renders null or NaN into a sentence", () => {
    expect(humanDuration(null)).toBe("unknown");
    expect(humanDuration(undefined)).toBe("unknown");
  });
});

describe("humanMinutes", () => {
  it("rounds to something a parent can act on", () => {
    expect(humanMinutes(0)).toBe("0 m");
    expect(humanMinutes(90)).toBe("2 m");
    expect(humanMinutes(3_600)).toBe("1 h");
    expect(humanMinutes(5_040)).toBe("1 h 24 m");
  });
});

describe("weekdayOf", () => {
  // ★ This feeds "still enforcing the rules from Tuesday". A wrong or
  // missing value makes the most important sentence in the product read
  // oddly, so the absent case has to be handled by the caller, not papered
  // over here.
  it("★ returns undefined for a missing or unparseable date", () => {
    expect(weekdayOf(null)).toBeUndefined();
    expect(weekdayOf(undefined)).toBeUndefined();
    expect(weekdayOf("not a date")).toBeUndefined();
  });

  it("says today and yesterday rather than naming the weekday", () => {
    expect(weekdayOf(new Date().toISOString())).toBe("today");
    expect(weekdayOf(new Date(Date.now() - 86_400_000).toISOString())).toBe("yesterday");
  });

  it("names the weekday further back", () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString();
    expect(weekdayOf(fourDaysAgo)).toMatch(/day$/);
  });
});

describe("appName", () => {
  it("shortens a bundle id to something readable", () => {
    expect(appName("com.apple.Safari")).toBe("Safari");
    expect(appName("com.microsoft.VSCode")).toBe("VSCode");
  });

  it("keeps an id it cannot shorten", () => {
    expect(appName("Minecraft")).toBe("Minecraft");
  });

  // The report query folds the tail of the app list into `other`, and the
  // bucket totals still include it — so it has to read as a real row.
  it("names the folded tail", () => {
    expect(appName("other")).toBe("Everything else");
  });
});

import { describe, expect, it } from "vitest";
import { defaultRange, parseRange, toLocalInput } from "./range.js";

describe("the Activity date range", () => {
  it("round-trips a local date-time through the input's format", () => {
    const date = new Date(2026, 8, 28, 21, 5);
    expect(toLocalInput(date)).toBe("2026-09-28T21:05");
    expect(new Date(toLocalInput(date)).getTime()).toBe(date.getTime());
  });

  it("defaults to the last 7 days, ending now", () => {
    const now = new Date(2026, 8, 28, 12, 0);
    expect(defaultRange(now)).toEqual({ from: "2026-09-21T12:00", to: "2026-09-28T12:00" });
  });

  it("★ reads hourly rollups up to 31 days — the API's cap — and daily past it", () => {
    const hourly = parseRange({ from: "2026-09-01T00:00", to: "2026-10-02T00:00" });
    expect("grain" in hourly && hourly.grain).toBe("hour");
    const daily = parseRange({ from: "2026-09-01T00:00", to: "2026-10-03T00:00" });
    expect("grain" in daily && daily.grain).toBe("day");
  });

  it("★ refuses a start after the end instead of asking the API", () => {
    expect(parseRange({ from: "2026-09-28T12:00", to: "2026-09-28T11:00" })).toEqual({
      error: "The start has to be before the end.",
    });
    expect("error" in parseRange({ from: "2026-09-28T12:00", to: "2026-09-28T12:00" })).toBe(true);
  });

  it("refuses an empty or unreadable field", () => {
    expect("error" in parseRange({ from: "", to: "2026-09-28T12:00" })).toBe(true);
    expect("error" in parseRange({ from: "nope", to: "2026-09-28T12:00" })).toBe(true);
  });

  it("refuses more than 400 days — past rollup retention", () => {
    expect(parseRange({ from: "2025-01-01T00:00", to: "2026-09-28T00:00" })).toEqual({
      error: "Pick a range of 400 days or less.",
    });
  });
});

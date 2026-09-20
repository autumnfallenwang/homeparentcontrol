import { describe, expect, it } from "vitest";
import { degradingEnum, eventId, timeOfDay } from "./primitives.js";

describe("event_id — A.12 / X5", () => {
  const v7 = "018f2a4e-0011-7a2b-8c3d-4e5f6a7b8c9d";

  it("accepts a canonical lowercase UUIDv7", () => {
    expect(eventId.parse(v7)).toBe(v7);
  });

  it("REJECTS uppercase rather than normalising it", () => {
    // The whole point of X5: one spelling. z.uuid({version:"v7"}) would accept
    // this, which is why the literal regex is used instead.
    expect(eventId.safeParse(v7.toUpperCase()).success).toBe(false);
  });

  it("rejects a UUIDv4 — the version nibble must be 7", () => {
    expect(eventId.safeParse("018f2a4e-0011-4a2b-8c3d-4e5f6a7b8c9d").success).toBe(false);
  });

  it("rejects a Crockford ULID", () => {
    expect(eventId.safeParse("01J9Z3XK7QMW3ZTD9F2W8B6C4A").success).toBe(false);
  });

  it("rejects a bad variant nibble", () => {
    expect(eventId.safeParse("018f2a4e-0011-7a2b-cc3d-4e5f6a7b8c9d").success).toBe(false);
  });
});

describe("timeOfDay", () => {
  it.each(["00:00", "09:05", "21:30", "23:59"])("accepts %s", (t) => {
    expect(timeOfDay.parse(t)).toBe(t);
  });

  it.each(["24:00", "7:00", "21:60", "21:3", ""])("rejects %s", (t) => {
    expect(timeOfDay.safeParse(t).success).toBe(false);
  });
});

describe("degradingEnum — R5", () => {
  const { strict, tolerant } = degradingEnum(["warn_only", "lock", "shutdown"], "lock");

  it("passes known values through", () => {
    expect(tolerant.parse("shutdown")).toBe("shutdown");
  });

  it("degrades an unknown value to the safe default instead of throwing", () => {
    expect(tolerant.parse("selfdestruct")).toBe("lock");
  });

  it("exposes a strict twin so the degradation is detectable and nameable", () => {
    // R5 requires telling the parent WHICH field degraded — impossible if the
    // tolerant schema silently swallows it with no way to ask.
    expect(strict.safeParse("selfdestruct").success).toBe(false);
  });
});

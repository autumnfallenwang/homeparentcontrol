import { describe, expect, it } from "vitest";
import { CONTRACT_MAJOR_PATH, CONTRACT_MINOR } from "./version.js";

describe("contract version", () => {
  it("exposes a numeric minor version", () => {
    expect(typeof CONTRACT_MINOR).toBe("number");
    expect(CONTRACT_MINOR).toBeGreaterThanOrEqual(1);
  });

  it("exposes a major path that a router can mount directly", () => {
    expect(CONTRACT_MAJOR_PATH).toMatch(/^\/v\d+$/);
  });
});

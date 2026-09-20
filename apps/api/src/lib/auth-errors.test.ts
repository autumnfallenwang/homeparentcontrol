import { describe, expect, it } from "vitest";
import { isRateLimitError } from "./auth-errors.js";

/**
 * The point of this function is that a throttle must not masquerade as a
 * revoked credential — see X2. Better Auth has expressed "too many requests"
 * three different ways across versions, so all three must match.
 */
describe("isRateLimitError", () => {
  it("matches a numeric status", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
  });

  it("matches a SCREAMING_CASE status string", () => {
    expect(isRateLimitError({ status: "TOO_MANY_REQUESTS" })).toBe(true);
  });

  it("matches a body code", () => {
    expect(isRateLimitError({ body: { code: "RATE_LIMITED" } })).toBe(true);
    expect(isRateLimitError({ body: { message: "Too many requests" } })).toBe(true);
  });

  it("does NOT match a plain auth failure", () => {
    // The whole point: an invalid key must stay a 401 and not be reported as
    // a throttle, or the agent's 401 handling gets bypassed.
    expect(isRateLimitError({ status: 401, body: { code: "UNAUTHORIZED" } })).toBe(false);
    expect(isRateLimitError({ status: "INVALID_API_KEY" })).toBe(false);
  });

  it("tolerates junk", () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError("429")).toBe(false);
    expect(isRateLimitError({})).toBe(false);
    expect(isRateLimitError({ body: null })).toBe(false);
  });
});

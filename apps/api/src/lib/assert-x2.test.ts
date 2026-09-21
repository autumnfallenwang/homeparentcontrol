import { describe, expect, it } from "vitest";
import { isMissingTable } from "./assert-x2.js";

/**
 * ★ "I cannot check" is not "the check passed", and it is not "the check
 * failed" either.
 *
 * The X2 boot assertion refuses to start in both cases — running against a
 * schema it cannot inspect is exactly the state it exists to prevent — but
 * the two need different messages. On a first deploy the missing-table
 * branch is the normal path, and the original message said `X2 violated`,
 * which reads as "armed keys were found" and sends the reader looking for
 * rows in a table that is not there. Observed on the first cluster deploy,
 * 2026-09-21.
 */
describe("isMissingTable", () => {
  /**
   * ★ The one that matters, and the one a message-only check fails.
   *
   * postgres-js wraps the driver error, so the top-level message is just
   * `Failed query: …` with no mention of a missing relation. The first
   * version of this predicate matched on text alone and would NOT have
   * fired on the error it was written for.
   */
  it("★ recognises the real wrapped postgres-js error by its CODE", () => {
    const wrapped = Object.assign(
      new Error(
        'Failed query: select "id", "name" from "apikeys" where "apikeys"."rate_limit_enabled" = $1',
      ),
      { cause: Object.assign(new Error('relation "apikeys" does not exist'), { code: "42P01" }) },
    );
    expect(isMissingTable(wrapped)).toBe(true);
  });

  it("recognises the bare driver error too", () => {
    expect(isMissingTable(Object.assign(new Error("nope"), { code: "42P01" }))).toBe(true);
    expect(isMissingTable(new Error('relation "apikeys" does not exist'))).toBe(true);
  });

  /**
   * ⚠️ The control. A predicate that returned true for everything would turn
   * a genuine query bug into "run the migrations" — worse than the message
   * it replaced, because it would send the reader somewhere harmless.
   */
  it("★ does NOT swallow a real failure", () => {
    expect(isMissingTable(new Error('column "rate_limit_enabled" does not exist'))).toBe(false);
    expect(isMissingTable(Object.assign(new Error("boom"), { code: "42703" }))).toBe(false);
    expect(isMissingTable(new Error("connection refused"))).toBe(false);
    expect(isMissingTable(new Error("permission denied for table apikeys"))).toBe(false);
    expect(isMissingTable(undefined)).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });

  it("does not loop for ever on a self-referencing cause", () => {
    const loop: { cause?: unknown; message: string } = { message: "x" };
    loop.cause = loop;
    expect(isMissingTable(loop)).toBe(false);
  });
});

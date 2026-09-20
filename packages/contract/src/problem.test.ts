import { describe, expect, it } from "vitest";
import { ACTION_BY_STATUS, HALTING_ACTION, HPC_ACTIONS, problemDocument } from "./problem.js";

describe("problem+json — §4.7", () => {
  it("parses the document from the spec verbatim", () => {
    const doc = {
      type: "https://hpc.arch.internal/problems/device-revoked",
      title: "Device credential revoked",
      status: 401,
      detail: "This device's credential was revoked by the account owner at 2026-09-18T19:02:11Z.",
      instance: "/api/agent/v1/sync",
      hpc_action: "halt_sync_keep_enforcing",
    };
    expect(problemDocument.parse(doc)).toMatchObject({ hpc_action: "halt_sync_keep_enforcing" });
  });

  it("rejects an unknown hpc_action", () => {
    expect(
      problemDocument.safeParse({ type: "x", title: "y", status: 400, hpc_action: "nope" }).success,
    ).toBe(false);
  });

  it("has exactly the eight actions from the spec", () => {
    expect([...HPC_ACTIONS].sort()).toEqual(
      [
        "backoff",
        "decommission",
        "drop_batch",
        "drop_event",
        "halt_sync_keep_enforcing",
        "halve_batch",
        "reenroll",
        "upgrade_required",
      ].sort(),
    );
  });
});

describe("status -> action mapping — §4.7's table", () => {
  it.each([
    [400, "drop_batch"],
    [401, "halt_sync_keep_enforcing"],
    [403, "halt_sync_keep_enforcing"],
    [409, "reenroll"],
    [410, "decommission"],
    [413, "halve_batch"],
    [422, "drop_event"],
    [426, "upgrade_required"],
    [429, "backoff"],
  ])("%i -> %s", (status, action) => {
    expect(ACTION_BY_STATUS[status]).toBe(action);
  });

  it("410/decommission is the ONLY action that stops enforcement", () => {
    // X1b: 401 must keep enforcing, or credential revocation becomes a bypass.
    expect(HALTING_ACTION).toBe("decommission");
    const halting = Object.entries(ACTION_BY_STATUS).filter(([, a]) => a === HALTING_ACTION);
    expect(halting).toEqual([["410", "decommission"]]);
    expect(ACTION_BY_STATUS[401]).not.toBe(HALTING_ACTION);
  });
});

import { describe, expect, it } from "vitest";
import { getSigningKey } from "../policy/signing.js";
import { negotiate, serverCapabilities } from "./capabilities.js";

describe("serverCapabilities", () => {
  it("claims only what the code behind it can actually do", () => {
    const caps = serverCapabilities();
    expect(caps).toContain("policy.v1");
    expect(caps).toContain("policy.overrides");
    expect(caps).toContain("desired.agent_version");

    // ⚠️ Not yet built. `/events` is step 4c; the rest are phase 3. Claiming
    // one here would tell the agent to expect behaviour that does not exist.
    expect(caps).not.toContain("telemetry.session");
    expect(caps).not.toContain("telemetry.app_usage");
    expect(caps).not.toContain("desired.diagnostics");
    expect(caps).not.toContain("desired.self_test");
    expect(caps).not.toContain("desired.credential");
  });

  it("advertises ed25519 signing only when a key is configured", () => {
    // Otherwise the agent expects a `jws` it will never get, and
    // `policy_unsigned` has no health consequence to catch the discrepancy.
    const signed = serverCapabilities().includes("policy.signature.ed25519");
    expect(signed).toBe(getSigningKey() !== null);
  });

  it("has no duplicates", () => {
    const caps = serverCapabilities();
    expect(new Set(caps).size).toBe(caps.length);
  });
});

describe("negotiate — R4", () => {
  it("returns the intersection, not the server's whole list", () => {
    // "The server sends a device only what that device advertised."
    expect(negotiate(["policy.v1"])).toEqual(["policy.v1"]);
  });

  it("drops capabilities the device did not advertise", () => {
    expect(negotiate(["policy.v1"])).not.toContain("desired.agent_version");
  });

  it("never echoes back something the server cannot do", () => {
    // An older or forked agent advertising a capability we have never heard of
    // must not get it confirmed.
    expect(negotiate(["policy.v1", "telemetry.quantum"])).not.toContain("telemetry.quantum");
  });

  it("returns nothing for a device that advertises nothing", () => {
    expect(negotiate([])).toEqual([]);
  });

  it("is stable in the server's own order, so log lines diff cleanly", () => {
    const advertised = [...serverCapabilities()].reverse();
    expect(negotiate(advertised)).toEqual(serverCapabilities());
  });
});

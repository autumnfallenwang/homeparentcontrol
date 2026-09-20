import { describe, expect, it } from "vitest";
import { assertRetentionInvariant, assertSigningConfigured, config } from "./config.js";

describe("retention invariant — §5.7", () => {
  it("passes with the shipped defaults (90 vs 14)", () => {
    expect(() => assertRetentionInvariant(config)).not.toThrow();
    expect(config.rawSampleRetentionDays).toBeGreaterThan(config.agentMaxQueueAgeDays);
  });

  it("throws when raw retention is shorter than the agent's queue age", () => {
    // The failure this prevents is silent: events arrive, are stored, and are
    // pruned before the projector runs. Nothing errors; the data is just gone.
    expect(() =>
      assertRetentionInvariant({ rawSampleRetentionDays: 7, agentMaxQueueAgeDays: 14 }),
    ).toThrow(/retention invariant violated/);
  });

  it("throws when they are merely equal — headroom is the point", () => {
    expect(() =>
      assertRetentionInvariant({ rawSampleRetentionDays: 14, agentMaxQueueAgeDays: 14 }),
    ).toThrow();
  });

  it("names both values so the operator can fix it without reading the source", () => {
    expect(() =>
      assertRetentionInvariant({ rawSampleRetentionDays: 3, agentMaxQueueAgeDays: 29 }),
    ).toThrow(/\(3\).*\(29\)/s);
  });
});

describe("assertSigningConfigured", () => {
  it("refuses to start with no key and no opt-in", () => {
    // The spec has no signing on/off flag and gives `policy_unsigned` no health
    // consequence at all, so a server that quietly stopped signing would look
    // exactly like one that signs. Make the dangerous state unreachable by
    // accident rather than merely logged.
    expect(() =>
      assertSigningConfigured({ policySigningKey: undefined, allowUnsignedPolicy: false }),
    ).toThrow(/POLICY_SIGNING_KEY/);
  });

  it("names both ways out in the error", () => {
    try {
      assertSigningConfigured({ policySigningKey: undefined, allowUnsignedPolicy: false });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/openssl genpkey/);
      expect((err as Error).message).toMatch(/ALLOW_UNSIGNED_POLICY=1/);
    }
  });

  it("passes when a key is present", () => {
    expect(() =>
      assertSigningConfigured({ policySigningKey: "-----BEGIN…", allowUnsignedPolicy: false }),
    ).not.toThrow();
  });

  it("passes when unsigned is opted into deliberately", () => {
    expect(() =>
      assertSigningConfigured({ policySigningKey: undefined, allowUnsignedPolicy: true }),
    ).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { assertRetentionInvariant, config } from "./config.js";

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

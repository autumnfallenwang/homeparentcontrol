import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appUsageSample, ENFORCEMENT_LOG_KINDS, sessionStateSample } from "./telemetry.js";

/**
 * ★ The other half of the Swift↔TypeScript interop check.
 *
 * `agent/Tests/HPCSyncTests/SampleSourceTests.swift` asserts the fixture is
 * what the Swift sampler emits today. This asserts the fixture is what the
 * projector can read.
 *
 * ⚠️ Why this needs to exist at all: R8 means `/events` stores anything. A
 * sampler that emitted `foregroundS` instead of `foreground_s` would be
 * accepted, persisted, counted as delivered, acknowledged — and then
 * contribute nothing to a single rollup. There is no error anywhere in that
 * chain. The only symptom is a report page that renders correctly with no
 * data in it, which reads as a quiet week rather than a bug.
 *
 * Regenerate the fixture with:
 *   HPC_WRITE_SAMPLER_FIXTURE=1 swift test --package-path agent \
 *     --filter SamplerInteropTests
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "../../../agent/Tests/HPCCoreTests/Fixtures/sampler-events.json");

interface Emitted {
  type: string;
  data: Record<string, unknown>;
}

const events: Emitted[] = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("the Swift sampler's output, read by the projector's schemas", () => {
  it("the fixture is not empty — an empty one would pass every test below", () => {
    expect(events.length).toBeGreaterThan(0);
  });

  it("★ every app.usage_sample parses", () => {
    const samples = events.filter((e) => e.type === "app.usage_sample");
    expect(samples.length).toBeGreaterThan(0);
    for (const event of samples) {
      const parsed = appUsageSample.safeParse(event.data);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it("★ every session.state parses", () => {
    const transitions = events.filter((e) => e.type === "session.state");
    expect(transitions.length).toBeGreaterThan(0);
    for (const event of transitions) {
      const parsed = sessionStateSample.safeParse(event.data);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  // ★ Parsing is not enough. Zod's `.optional()` means a renamed field parses
  // happily and arrives as undefined, which the projector then sums as zero —
  // the exact silent-empty-report failure this file exists to catch.
  it("★ the fields the projector sums are actually PRESENT, not just optional", () => {
    const sample = events.find((e) => e.type === "app.usage_sample");
    const parsed = appUsageSample.parse(sample?.data);
    expect(parsed.bundle_id).toBeTruthy();
    expect(parsed.foreground_s).toBeGreaterThan(0);
    // `active_s` is A.33's meter and the one the reports are built on.
    expect(parsed.active_s).toBeGreaterThan(0);
    expect(parsed.cpu_pct).toBeDefined();
  });

  it("★ the session states are ones session_spans accepts", () => {
    for (const event of events.filter((e) => e.type === "session.state")) {
      // `.enum` rejects an unknown state outright, so this is the real check.
      expect(() => sessionStateSample.parse(event.data)).not.toThrow();
    }
  });

  it("a locked transition is present, so the lock path is covered", () => {
    const states = events
      .filter((e) => e.type === "session.state")
      .map((e) => sessionStateSample.parse(e.data).state);
    expect(states).toContain("locked");
  });

  // The sampler's own types must not accidentally be audit-class: they are
  // the bulk of the volume and the first thing eviction drops, which is
  // correct for a rollup and wrong for an enforcement record.
  it("neither sampler type is an enforcement_log kind", () => {
    for (const type of new Set(events.map((e) => e.type))) {
      if (type === "session.state") continue;
      expect(ENFORCEMENT_LOG_KINDS[type]).toBeUndefined();
    }
  });
});

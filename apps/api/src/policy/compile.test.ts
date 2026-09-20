import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { policyDocument } from "@hpc/contract";
import { describe, expect, it } from "vitest";
import { contentHash } from "./canonical.js";
import { compilePolicy } from "./compile.js";
import type { CompilerInput } from "./types.js";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "__golden__");

/** `UPDATE_GOLDEN=1 pnpm vitest run src/policy` rewrites the expectations. */
const UPDATE = process.env.UPDATE_GOLDEN === "1";

interface GoldenCase {
  name: string;
  /** Prose stating what the case pins down, carried in the fixture itself. */
  description: string;
  input: Omit<CompilerInput, "now"> & { now: string };
}

function loadCase(file: string): GoldenCase {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf-8")) as GoldenCase;
}

function hydrate(input: GoldenCase["input"]): CompilerInput {
  return {
    ...input,
    now: new Date(input.now),
    grants: input.grants.map((g) => ({ ...g, expiresAt: new Date(g.expiresAt) })),
  } as CompilerInput;
}

const caseFiles = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".input.json"))
  .sort();

/**
 * The golden-file suite §9 asks for: "the riskiest logic and the cheapest to
 * pin down; write the tests first."
 *
 * Every fixture is static JSON — holidays arrive as pre-resolved input rather
 * than from a live `date-holidays` call, so no case can rot on a library bump
 * or a year rollover. That is the whole reason the purity boundary sits where
 * it does.
 */
describe("compilePolicy — golden files", () => {
  it("has fixtures to run", () => {
    expect(caseFiles.length).toBeGreaterThan(0);
  });

  for (const file of caseFiles) {
    const kase = loadCase(file);
    it(`${kase.name} — ${kase.description}`, () => {
      const actual = compilePolicy(hydrate(kase.input));
      const expectedPath = join(GOLDEN_DIR, file.replace(".input.json", ".expected.json"));

      if (UPDATE) {
        writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
      }

      const expected = JSON.parse(readFileSync(expectedPath, "utf-8")) as unknown;
      expect(actual).toEqual(expected);
    });
  }

  it("every golden output is contract-conformant", () => {
    for (const file of caseFiles) {
      const actual = compilePolicy(hydrate(loadCase(file).input));
      expect(policyDocument.safeParse(actual).success, file).toBe(true);
    }
  });

  it("is deterministic — recompiling the same input gives the same hash", () => {
    // The property the whole publish path rests on. If this can drift, every
    // compile looks like a change and the churn-killer is useless.
    for (const file of caseFiles) {
      const input = loadCase(file).input;
      const a = compilePolicy(hydrate(input));
      const b = compilePolicy(hydrate(input));
      expect(contentHash(a), file).toBe(contentHash(b));
    }
  });
});

describe("compilePolicy — invariants", () => {
  const base = () => hydrate(loadCase("basic-school-nights.input.json").input);

  it("never emits fail_mode — X11 removed it", () => {
    // §4.3, §5.6's own pseudocode and policy_sets all still carry it.
    expect(compilePolicy(base())).not.toHaveProperty("fail_mode");
  });

  it("never emits a staleness max-age — X1c", () => {
    // A TTL that stops enforcement is a remotely-triggerable bypass.
    const staleness = compilePolicy(base()).staleness as Record<string, unknown>;
    expect(Object.keys(staleness)).toEqual(["warn_after_s"]);
  });

  it("emits confirm_immediate_effect: false until the /rules UI exists", () => {
    expect(compilePolicy(base()).confirm_immediate_effect).toBe(false);
  });

  it("orders days mon..sun regardless of how they were authored", () => {
    const input = base();
    input.windows[0]!.days = ["thu", "sun", "mon"];
    const [window] = compilePolicy(input).schedule.windows;
    expect(window?.days).toEqual(["mon", "thu", "sun"]);
  });

  it("orders warnings by descending lead time", () => {
    const input = base();
    input.windows[0]!.warnings = [
      { leadMinutes: 5, channel: "modal" },
      { leadMinutes: 30, channel: "banner" },
      { leadMinutes: 1, channel: "modal" },
    ];
    const [window] = compilePolicy(input).schedule.windows;
    expect(window?.warnings.map((w) => w.lead_minutes)).toEqual([30, 5, 1]);
  });

  it("orders windows by sort_order, not by insertion", () => {
    const input = base();
    input.windows = [...input.windows].reverse();
    const sortOrders = compilePolicy(input).schedule.windows.map(
      (w) => input.windows.find((i) => i.id === w.id)?.sortOrder,
    );
    expect(sortOrders).toEqual([...sortOrders].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it("the child's timezone wins over the household's — A.30", () => {
    const input = base();
    input.child.timezone = "Asia/Taipei";
    expect(compilePolicy(input).timezone).toBe("Asia/Taipei");
  });

  it("inherits the household timezone when the child has none", () => {
    const input = base();
    input.child.timezone = null;
    expect(compilePolicy(input).timezone).toBe(input.household.timezone);
  });

  it("drops a relaxation that has already expired", () => {
    const input = base();
    input.grants = [
      {
        id: "018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d",
        type: "extend",
        windowId: null,
        minutes: 30,
        effectiveDate: "2026-09-20",
        expiresAt: new Date(input.now.getTime() - 1000),
        grantedBy: null,
        grantedVia: "ui",
        reason: "already over",
      },
    ];
    expect(compilePolicy(input).overrides).toHaveLength(0);
  });

  it("keeps a live relaxation", () => {
    const input = base();
    input.grants = [
      {
        id: "018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d",
        type: "extend",
        windowId: null,
        minutes: 30,
        effectiveDate: "2026-09-20",
        expiresAt: new Date(input.now.getTime() + 3_600_000),
        grantedBy: null,
        grantedVia: "ui",
        reason: "finishing history essay",
      },
    ];
    expect(compilePolicy(input).overrides).toHaveLength(1);
  });

  it("every emitted override carries an expiry — A.8", () => {
    // There is nowhere to store "never expires", and that is load-bearing:
    // a stale policy can then only ever converge stricter.
    for (const file of caseFiles) {
      for (const o of compilePolicy(hydrate(loadCase(file).input)).overrides) {
        expect(o.expires_at, `${file}: ${o.id}`).toBeTruthy();
      }
    }
  });

  it("clamps treat_as_weekend to the window's own length", () => {
    // A 13:00-15:00 window borrowing a 22:30 weekend start would otherwise
    // "extend" by 570 minutes — nine and a half hours past the rule it is
    // relaxing. Capped at 120, the window collapses to nothing instead.
    const input = hydrate(loadCase("non-wrapping-window.input.json").input);
    const [derived] = compilePolicy(input).overrides;
    expect(derived?.minutes).toBe(120);
  });

  it("never extends a window past its own duration, in any golden", () => {
    for (const file of caseFiles) {
      const input = hydrate(loadCase(file).input);
      const byId = new Map(input.windows.map((w) => [w.id, w]));
      for (const o of compilePolicy(input).overrides) {
        if (o.type !== "extend" || !o.window_id || !o.minutes) continue;
        const w = byId.get(o.window_id);
        if (!w) continue;
        const from = Number(w.restrictedFrom.slice(0, 2)) * 60 + Number(w.restrictedFrom.slice(3));
        const until =
          Number(w.restrictedUntil.slice(0, 2)) * 60 + Number(w.restrictedUntil.slice(3));
        const duration = w.crossesMidnight ? 1440 - from + until : until - from;
        expect(o.minutes, `${file}: ${o.id}`).toBeLessThanOrEqual(duration);
      }
    }
  });

  it("two devices on one policy set differ only by device_id", () => {
    // A.17 — authored per child, compiled per device.
    const a = base();
    const b = base();
    b.device.id = "018f2a4c-0000-7c9e-9d2a-3f5b7c1e4a60";
    const docA = compilePolicy(a) as Record<string, unknown>;
    const docB = compilePolicy(b) as Record<string, unknown>;
    expect(docA.device_id).not.toBe(docB.device_id);
    delete docA.device_id;
    delete docB.device_id;
    expect(docA).toEqual(docB);
  });
});

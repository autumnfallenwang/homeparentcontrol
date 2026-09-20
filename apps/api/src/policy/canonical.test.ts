import { policyDocument } from "@hpc/contract";
import { describe, expect, it } from "vitest";
import {
  CONTENT_HASH_EXCLUDED,
  canonicalJson,
  contentHash,
  deterministicUuid,
  etagFor,
} from "./canonical.js";
import type { PolicyDocument } from "./types.js";

function doc(overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  return policyDocument.parse({
    policy_version: 1,
    issued_at: "2026-09-20T12:00:00.000Z",
    not_before: "2026-09-20T12:00:00.000Z",
    device_id: "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
    subject: { child_id: "018f2a4b-6a20-7b8d-8c1f-2e4a6b8d0f31", display_name: "Lucy" },
    timezone: "America/New_York",
    confirm_immediate_effect: false,
    schedule: { kind: "windows", windows: [] },
    overrides: [],
    expected_online: [],
    ...overrides,
  });
}

describe("canonicalJson", () => {
  it("is insensitive to key order", () => {
    // The whole point: two serialisations of equal content must be one string,
    // or the content hash cannot detect "nothing changed".
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}');
  });

  it("preserves array order — that is the compiler's to decide, not ours", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ a: [{ b: 1, a: 2 }] })).toBe('{"a":[{"a":2,"b":1}]}');
  });

  it("emits no whitespace", () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });

  it("round-trips unicode", () => {
    const parsed = JSON.parse(canonicalJson({ name: "Lucy 露西 🎄" })) as { name: string };
    expect(parsed.name).toBe("Lucy 露西 🎄");
  });

  it("handles null without treating it as an object", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });
});

describe("contentHash", () => {
  it("ignores the three envelope fields that change every compile", () => {
    // Without this exclusion §5.6's "RETURN unchanged" is dead code and the
    // milestone exit criterion is unmeetable.
    const a = doc({ policy_version: 1, issued_at: "2026-09-20T12:00:00.000Z" });
    const b = doc({ policy_version: 99, issued_at: "2027-01-01T00:00:00.000Z" });
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("excludes exactly those three and nothing more", () => {
    expect([...CONTENT_HASH_EXCLUDED]).toEqual(["policy_version", "issued_at", "not_before"]);
  });

  it("changes when authored content changes", () => {
    const base = doc();
    const changed = doc({ timezone: "Europe/London" });
    expect(contentHash(base)).not.toBe(contentHash(changed));
  });

  it("notices a changed window, which is the case that matters", () => {
    const withWindow = doc({
      schedule: {
        kind: "windows",
        windows: [
          {
            id: "018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42",
            label: "School nights",
            days: ["mon"],
            restricted_from: "21:30",
            restricted_until: "07:00",
            action: "lock",
            warnings: [],
          },
        ],
      },
    });
    const later = doc({
      schedule: {
        kind: "windows",
        windows: [
          {
            id: "018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42",
            label: "School nights",
            days: ["mon"],
            restricted_from: "22:00",
            restricted_until: "07:00",
            action: "lock",
            warnings: [],
          },
        ],
      },
    });
    expect(contentHash(withWindow)).not.toBe(contentHash(later));
  });

  it("is a 64-char hex sha256", () => {
    expect(contentHash(doc())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("etagFor", () => {
  it("uses TWELVE hash characters, not §4.2's eight", () => {
    const etag = etagFor("0123456789abcdef0123", 42);
    expect(etag).toBe('W/"pol-0123456789ab-v42"');
    expect(etag).toMatch(/^W\/"pol-[0-9a-f]{12}-v\d+"$/);
  });
});

describe("deterministicUuid", () => {
  it("is stable across calls — or every compile churns a new version", () => {
    const a = deterministicUuid("exception", "abc", "win1", "2026-12-25");
    const b = deterministicUuid("exception", "abc", "win1", "2026-12-25");
    expect(a).toBe(b);
  });

  it("differs when any part differs", () => {
    const base = deterministicUuid("exception", "abc", "win1", "2026-12-25");
    expect(deterministicUuid("exception", "abc", "win2", "2026-12-25")).not.toBe(base);
    expect(deterministicUuid("exception", "abc", "win1", "2026-12-26")).not.toBe(base);
    expect(deterministicUuid("holiday", "abc", "win1", "2026-12-25")).not.toBe(base);
  });

  it("does not collide across part boundaries", () => {
    // "ab" + "c" must not hash the same as "a" + "bc".
    expect(deterministicUuid("ab", "c")).not.toBe(deterministicUuid("a", "bc"));
  });

  it("satisfies the contract's uuid primitive", () => {
    const id = deterministicUuid("holiday", "2026-12-25", "win1");
    expect(policyDocument.shape.device_id.safeParse(id).success).toBe(true);
  });
});

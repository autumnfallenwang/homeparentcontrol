import { describe, expect, it } from "vitest";
import { actionOptions, enforcementActionStrict, override, policyDocument } from "./policy.js";

const minimal = {
  policy_version: 43,
  issued_at: "2026-09-18T20:30:55.000Z",
  not_before: "2026-09-18T20:30:55.000Z",
  device_id: "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
  subject: { child_id: "018f2a4b-6a20-7b8d-8c1f-2e4a6b8d0f31", display_name: "Lucy" },
  timezone: "America/New_York",
  schedule: { kind: "windows" as const, windows: [] },
};

const anOverride = {
  id: "018f2a4d-1122-7a3b-8c4d-5e6f7a8b9c0d",
  type: "extend",
  minutes: 30,
  effective_date: "2026-09-18",
  expires_at: "2026-09-19T05:00:00Z",
  granted_via: "ui",
};

describe("policy document", () => {
  it("parses a minimal document", () => {
    expect(policyDocument.parse(minimal).policy_version).toBe(43);
  });

  it("strips unknown fields rather than rejecting them — R1", () => {
    const out = policyDocument.parse({ ...minimal, some_future_field: true });
    expect("some_future_field" in out).toBe(false);
  });

  it("does not carry fail_mode — X11 removed it", () => {
    const out = policyDocument.parse({ ...minimal, fail_mode: "closed" });
    expect("fail_mode" in out).toBe(false);
  });
});

describe("overrides — the load-bearing invariant", () => {
  it("accepts an override with an expiry", () => {
    expect(override.parse(anOverride).expires_at).toBe("2026-09-19T05:00:00Z");
  });

  it("REJECTS an override with no expires_at — a permanent relaxation must be unrepresentable", () => {
    const { expires_at: _omitted, ...noExpiry } = anOverride;
    expect(override.safeParse(noExpiry).success).toBe(false);
  });

  it("rejects a null expires_at too", () => {
    expect(override.safeParse({ ...anOverride, expires_at: null }).success).toBe(false);
  });

  it("has no offline_code granted_via — D.5 deferred it", () => {
    expect(override.parse({ ...anOverride, granted_via: "offline_code" }).granted_via).toBe("ui");
  });
});

describe("enforcement action — R5", () => {
  it("degrades an unrecognised action to lock", () => {
    const p = policyDocument.parse({
      ...minimal,
      schedule: {
        kind: "windows",
        windows: [
          {
            id: "018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42",
            label: "School nights",
            days: ["mon"],
            restricted_from: "21:30",
            restricted_until: "07:00",
            action: "vaporise",
          },
        ],
      },
    });
    expect(p.schedule.windows[0]?.action).toBe("lock");
    expect(enforcementActionStrict.safeParse("vaporise").success).toBe(false);
  });
});

describe("shutdown_grace_s — X12", () => {
  it("rejects 0, which would silently reconstitute bare shutdown", () => {
    expect(actionOptions.safeParse({ shutdown_grace_s: 0 }).success).toBe(false);
  });

  it("rejects anything below 60", () => {
    expect(actionOptions.safeParse({ shutdown_grace_s: 59 }).success).toBe(false);
  });

  it("accepts the documented default of 300", () => {
    expect(actionOptions.parse({ shutdown_grace_s: 300 }).shutdown_grace_s).toBe(300);
  });
});

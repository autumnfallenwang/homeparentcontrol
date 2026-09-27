import { describe, expect, it } from "vitest";
import type { DeviceSummary } from "./parent-api.js";
import { defaultChild, publishTargets } from "./publish-target.js";

const device = (id: string, status: string, childId = "c1", label = id): DeviceSummary => ({
  id,
  label,
  status,
  childId,
  healthState: null,
});

describe("publishTargets", () => {
  it("skips a pending device that was created first — the smoke-test household", () => {
    // Exactly what the first real run had: a burned code left a pending row
    // ahead of the Mac that actually enrolled.
    const rows = [device("d506f53e", "pending"), device("e0e39531", "enrolled")];
    expect(publishTargets(rows, "c1").map((d) => d.id)).toEqual(["e0e39531"]);
  });

  it("never offers another child's Mac", () => {
    const rows = [device("theirs", "active", "c2"), device("ours", "enrolled", "c1")];
    expect(publishTargets(rows, "c1").map((d) => d.id)).toEqual(["ours"]);
  });

  it("orders active, then enrolled, then revoked", () => {
    const rows = [device("r", "revoked"), device("e", "enrolled"), device("a", "active")];
    expect(publishTargets(rows, "c1").map((d) => d.id)).toEqual(["a", "e", "r"]);
  });

  it("returns nothing when no Mac has enrolled, rather than a pending one", () => {
    expect(publishTargets([device("p", "pending")], "c1")).toEqual([]);
    expect(publishTargets([device("a", "active")], null)).toEqual([]);
  });
});

describe("defaultChild", () => {
  const rules = (ids: string[]) => ({
    children: ids.map((id) => ({ id, displayName: id, timezone: null })),
    policy_sets: ids.map((id) => ({
      id: `set-${id}`,
      child_id: id,
      override_enabled: true,
      override_allowed_minutes: [],
      override_caps: { max_minutes_per_day: 0, max_grants_per_day: 0 },
      windows: [],
    })),
  });

  it("opens on the child whose Mac enrolled — the first real run's household", () => {
    // Aarontest's only Mac never enrolled; Lucy's did. The page used to open
    // on Aarontest's rules, and a publish to Lucy's Mac answered `unchanged`.
    const devices = [
      device("d506f53e", "pending", "aaron"),
      device("e0e39531", "enrolled", "lucy"),
    ];
    expect(defaultChild(rules(["aaron", "lucy"]), devices)).toBe("lucy");
  });

  it("falls back to the first child with rules when no Mac has enrolled", () => {
    expect(defaultChild(rules(["aaron", "lucy"]), [])).toBe("aaron");
  });

  it("is null when there is nothing to edit", () => {
    expect(defaultChild(rules([]), [])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { DeviceSummary } from "./parent-api.js";
import { publishTargets } from "./publish-target.js";

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

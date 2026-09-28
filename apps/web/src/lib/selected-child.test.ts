import { describe, expect, it } from "vitest";
import type { DeviceCard } from "./parent-api.js";
import { childrenNeedingYou, pickChild } from "./selected-child.js";

const child = (id: string) => ({ id, displayName: id });
const device = (id: string, status: string, childId: string) => ({
  id,
  label: id,
  status,
  childId,
});

describe("pickChild", () => {
  it("keeps the saved choice while that child exists", () => {
    const devices = [device("mac", "enrolled", "lucy")];
    expect(pickChild("max", [child("lucy"), child("max")], devices)).toBe("max");
  });

  it("★ opens on the child whose Mac enrolled — the first real run's household", () => {
    // Aarontest's only Mac never enrolled; Lucy's did. The rules page used to
    // open on Aarontest, and a publish to Lucy's Mac answered `unchanged`.
    const devices = [
      device("d506f53e", "pending", "aaron"),
      device("e0e39531", "enrolled", "lucy"),
    ];
    expect(pickChild(null, [child("aaron"), child("lucy")], devices)).toBe("lucy");
  });

  it("forgets a saved child that has gone", () => {
    expect(pickChild("removed", [child("lucy")], [])).toBe("lucy");
  });

  it("falls back to the first child when no device has enrolled", () => {
    expect(pickChild(null, [child("aaron"), child("lucy")], [])).toBe("aaron");
  });

  it("is null when there are no children", () => {
    expect(pickChild("lucy", [], [])).toBeNull();
  });
});

describe("childrenNeedingYou", () => {
  const card = (childId: string | null, overrides: Partial<DeviceCard> = {}) =>
    ({
      device_id: `mac-${childId}`,
      child: childId ? { id: childId, display_name: childId, timezone: null } : null,
      health: { state: "HEALTHY" },
      banner: null,
      shadow_mode: false,
      ...overrides,
    }) as unknown as DeviceCard;

  it("★ marks the child whose Mac went quiet, not the one being viewed", () => {
    const cards = [
      card("lucy"),
      card("max", { health: { state: "SILENT_TOO_LONG" } as DeviceCard["health"] }),
    ];
    expect([...childrenNeedingYou(cards)]).toEqual(["max"]);
  });

  it("counts a Mac that is not enforcing yet, and a tripwire", () => {
    const cards = [
      card("lucy", { shadow_mode: true }),
      card("max", { banner: {} as DeviceCard["banner"] }),
    ];
    expect([...childrenNeedingYou(cards)].sort()).toEqual(["lucy", "max"]);
  });

  it("ignores a device that belongs to no child", () => {
    expect(childrenNeedingYou([card(null, { shadow_mode: true })]).size).toBe(0);
  });
});

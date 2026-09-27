import { describe, expect, it } from "vitest";
import { APPLIED_VISIBLE_MS, type Pending, settlePending } from "./grant-progress.js";

const card = (applied: number | null) => ({
  device_id: "mac",
  health: { applied_policy_version: applied },
});
const sent = (at: number): Record<string, Pending> => ({
  mac: { sentAt: at, result: { awaiting_policy_version: 3 } },
});

describe("settlePending — keeping 'Applied ✓' on screen", () => {
  it("★ a Mac that confirms LATE still shows Applied — the banner is not retired on sight", () => {
    // Sent at 0, first seen applied 40 s later (a 60 s check-in). The old
    // rule — applied and sent > 8 s ago — removed it on this very poll.
    const next = settlePending(sent(0), [card(3)], 40_000);
    expect(next.mac?.appliedSeenAt).toBe(40_000);
  });

  it("retires it once it has been visible for a while", () => {
    const seen = settlePending(sent(0), [card(3)], 40_000);
    const later = settlePending(seen, [card(3)], 40_000 + APPLIED_VISIBLE_MS + 1);
    expect(later.mac).toBeUndefined();
  });

  it("keeps waiting while the Mac has not applied it yet", () => {
    const current = sent(0);
    expect(settlePending(current, [card(2)], 90_000)).toBe(current);
  });

  it("returns the same object when nothing changed, so React does not re-render", () => {
    const seen = settlePending(sent(0), [card(3)], 1_000);
    expect(settlePending(seen, [card(3)], 2_000)).toBe(seen);
  });
});

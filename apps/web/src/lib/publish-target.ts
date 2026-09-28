import type { DeviceSummary } from "./parent-api.js";

/** What ranking needs — `GET /setup` rows qualify as well as `GET /devices` ones. */
export type TargetCandidate = Pick<DeviceSummary, "id" | "label" | "status" | "childId">;

/**
 * Which Macs a rules change can be published to, best first.
 *
 * ⚠️ Found on the first real smoke test. The rules page used to take
 * `devices[0]` — whatever row Postgres returned first, with no ordering and
 * no filter. A household whose first enrolment code expired has a `pending`
 * device that will never check in, created BEFORE the one that did; publishing
 * to it succeeds, returns 200, and reaches nothing. The parent sees a working
 * publish and a Mac that never changes.
 *
 * - Only the edited set's child: another child's Mac obeys another set.
 * - Never `pending`: it has not enrolled, so nothing will ever fetch the policy.
 * - `revoked` last but kept: it is still enforcing its cached policy, and it
 *   picks up the latest version the moment it is re-credentialed.
 */
const RANK: Record<string, number> = { active: 0, enrolled: 1, revoked: 2 };

export function publishTargets<T extends TargetCandidate>(
  devices: readonly T[],
  childId: string | null,
): T[] {
  if (!childId) return [];
  return devices
    .filter((device) => device.childId === childId && device.status in RANK)
    .sort(
      (a, b) =>
        (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) ||
        (a.label ?? "").localeCompare(b.label ?? ""),
    );
}

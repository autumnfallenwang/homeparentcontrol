import type { DeviceSummary, RulesPayload } from "./parent-api.js";

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

export function publishTargets(
  devices: readonly DeviceSummary[],
  childId: string | null,
): DeviceSummary[] {
  if (!childId) return [];
  return devices
    .filter((device) => device.childId === childId && device.status in RANK)
    .sort(
      (a, b) =>
        (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) ||
        (a.label ?? "").localeCompare(b.label ?? ""),
    );
}

/**
 * Whose rules the page opens on.
 *
 * ⚠️ The page used to edit `policy_sets[0]` — whichever set the server listed
 * first — with no way to choose. On the first real run the household had two
 * children; the edit landed in the one whose only Mac never enrolled, and
 * publishing to the real Mac answered `unchanged`. Default to the first child
 * whose rules can actually reach a Mac; the page offers the rest in a picker.
 */
export function defaultChild(
  rules: Pick<RulesPayload, "children" | "policy_sets">,
  devices: readonly DeviceSummary[],
): string | null {
  const withRules = rules.children.filter((child) =>
    rules.policy_sets.some((set) => set.child_id === child.id),
  );
  const reachable = withRules.find((child) => publishTargets(devices, child.id).length > 0);
  return (reachable ?? withRules[0])?.id ?? null;
}

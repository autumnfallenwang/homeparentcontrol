import type { DeviceCard } from "./parent-api.js";
import { publishTargets, type TargetCandidate } from "./publish-target.js";

/**
 * Which child the app is showing — homework's "Viewing" switch.
 *
 * Today, Rules and Activity are each about ONE child. The choice is kept per
 * browser: the tablet on the kitchen counter can stay on one child while a
 * parent's laptop sits on the other.
 */
export const VIEWING_KEY = "hpc.viewing.child";

export interface ChildRow {
  id: string;
  displayName: string;
}

/**
 * The saved choice while that child still exists; otherwise a sensible one.
 *
 * ⚠️ Not simply the first child. On the first real run the household had two
 * children, and the rules page opened on the one whose only Mac never
 * enrolled — the edit landed there, and publishing to the real Mac answered
 * `unchanged`. So with nothing saved, open on the first child whose rules can
 * actually reach a device.
 */
export function pickChild(
  saved: string | null,
  children: readonly ChildRow[],
  devices: readonly TargetCandidate[],
): string | null {
  if (saved && children.some((child) => child.id === saved)) return saved;
  const reachable = children.find((child) => publishTargets(devices, child.id).length > 0);
  return (reachable ?? children[0])?.id ?? null;
}

/** A device that needs a person: not enforcing, not healthy, or a tripwire. */
export function needsAttention(card: DeviceCard): boolean {
  return card.shadow_mode || card.health.state !== "HEALTHY" || card.banner !== null;
}

/**
 * The children with at least one device that needs a person.
 *
 * ★ Shown beside the names in the Viewing list. Scoping every page to one
 * child must not hide the other child's alarm — a silent Mac is exactly the
 * thing a parent needs to see without going looking for it.
 */
export function childrenNeedingYou(cards: readonly DeviceCard[]): Set<string> {
  const ids = new Set<string>();
  for (const card of cards) {
    if (card.child && needsAttention(card)) ids.add(card.child.id);
  }
  return ids;
}

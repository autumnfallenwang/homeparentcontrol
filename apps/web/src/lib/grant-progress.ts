/**
 * When a grant's progress banner goes away.
 *
 * ★ "Applied ✓" is the agent's word (§5.8), and it is the one thing the
 * parent is standing there waiting to read. It must be ON SCREEN for a while.
 *
 * ⚠️ This used to retire the banner once the grant was applied AND sent more
 * than 8 s ago — both checked on the same poll. Whenever the Mac took longer
 * than 8 s to confirm (the normal case: it checks in every 60 s), the poll
 * that first saw "applied" was the one that removed the banner, so "Applied ✓"
 * was never visible — "Sent ✓ … waiting", then nothing. Found walking the
 * rebuilt Today page. Now the clock starts when "applied" is first SEEN.
 */
export const APPLIED_VISIBLE_MS = 15_000;

export interface Pending {
  sentAt: number;
  /** When a poll first saw the Mac report the new policy version. */
  appliedSeenAt?: number;
  result: { awaiting_policy_version: number | null };
}

export interface Reporting {
  device_id: string;
  health: { applied_policy_version: number | null };
}

/** The next pending map, or the SAME object when nothing changed. */
export function settlePending<T extends Pending>(
  current: Record<string, T>,
  cards: readonly Reporting[],
  now: number,
): Record<string, T> {
  let next: Record<string, T> | null = null;
  for (const card of cards) {
    const grant = current[card.device_id];
    const target = grant?.result.awaiting_policy_version;
    if (!grant || target === null || target === undefined) continue;
    if ((card.health.applied_policy_version ?? -1) < target) continue;

    if (grant.appliedSeenAt === undefined) {
      next ??= { ...current };
      next[card.device_id] = { ...grant, appliedSeenAt: now };
    } else if (now - grant.appliedSeenAt > APPLIED_VISIBLE_MS) {
      next ??= { ...current };
      delete next[card.device_id];
    }
  }
  return next ?? current;
}

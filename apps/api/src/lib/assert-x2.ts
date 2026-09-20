import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apikeys } from "../db/schema.js";

/**
 * ★ X2, PLACE 3 OF 4 — refuse to start rather than run into it.
 *
 * Places 1 and 2 turn the per-key limiter off at the plugin and at the row.
 * This is what catches the case where one of them was removed, or where a row
 * was written by something that bypassed `mintDeviceKey()` — a hand-run SQL
 * insert, a restored backup from before the carve-out, a future better-auth
 * migration that re-defaults the column.
 *
 * A throttled device key does not fail loudly: after 10 requests it starts
 * failing in a way that is indistinguishable from a revoked credential, and
 * the agent responds by halting sync while it keeps enforcing a stale policy.
 * That is silent and unbounded, so crashing at boot is the cheaper failure by
 * a wide margin.
 *
 * Separate from `assertRetentionInvariant` because this one queries the
 * database, so it cannot live in `config.ts` with the pure checks.
 */
export async function assertNoRateLimitedDeviceKeys(): Promise<void> {
  const bad = await db
    .select({ id: apikeys.id, name: apikeys.name })
    .from(apikeys)
    .where(eq(apikeys.rateLimitEnabled, true));

  if (bad.length > 0) {
    const ids = bad.map((k) => `${k.id}${k.name ? ` (${k.name})` : ""}`).join(", ");
    throw new Error(
      `X2 violated: ${bad.length} api key(s) have rate_limit_enabled = true: ${ids}. ` +
        "better-auth's per-key limiter allows 10 requests per 24h and then fails in a way the " +
        "agent reads as a revoked credential — it would halt syncing while still enforcing a " +
        "stale policy. Set rate_limit_enabled = false on these rows, and mint only via " +
        "mintDeviceKey().",
    );
  }
}

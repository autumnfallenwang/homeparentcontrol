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
/**
 * Does this database error mean "the table is not there yet" rather than
 * "the query is wrong"?
 *
 * ⚠️ **Match on the CODE, not the message.** postgres-js wraps the driver
 * error, so what reaches `catch` reads
 * `Failed query: select "id", "name" from "apikeys" where …` — with no
 * mention of a missing relation anywhere in it. A message-only check looks
 * right, passes review, and then fails to fire on the one error it was
 * written for. The first version of this did exactly that, and its own test
 * caught it.
 *
 * `42P01` is Postgres' `undefined_table`. The text patterns stay as a
 * fallback for a driver that surfaces the detail differently.
 *
 * Exported so the distinction is testable without a database — the branch it
 * guards is the one every first deploy takes and nobody exercises again.
 */
export function isMissingTable(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    const row = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (row.code === "42P01") return true;
    if (
      typeof row.message === "string" &&
      /relation .* does not exist|no such table|undefined_table/i.test(row.message)
    ) {
      return true;
    }
    current = row.cause;
  }
  return false;
}

export async function assertNoRateLimitedDeviceKeys(): Promise<void> {
  let bad: { id: string; name: string | null }[];
  try {
    bad = await db
      .select({ id: apikeys.id, name: apikeys.name })
      .from(apikeys)
      .where(eq(apikeys.rateLimitEnabled, true));
  } catch (error) {
    // ⚠️ **"I cannot check" is not "the check passed", and it is not "the
    // check failed" either.** Refusing to start is still right — running
    // against a schema we cannot inspect is exactly the state this
    // assertion exists to prevent — but the two need different messages.
    //
    // On a FIRST DEPLOY this is the normal path: the migrate hook has not
    // run, `apikeys` does not exist, and the api crashloops until it does.
    // Observed 2026-09-21 on the first cluster deploy, where the original
    // message said `X2 violated` and read as "armed keys were found",
    // sending the reader looking for rows in a table that was not there.
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingTable(error)) {
      throw new Error(
        "X2 unverifiable: the `apikeys` table does not exist, so it cannot be proven that no " +
          "device key has rate limiting armed. On a first deploy this is expected — run the " +
          "migrations (Helm `migrate.enabled=true`) and this will clear on the next start. " +
          "Refusing to start rather than run against an uninspectable schema.",
      );
    }
    throw new Error(`X2 unverifiable: the check itself failed — ${message}`);
  }

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

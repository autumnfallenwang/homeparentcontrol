/**
 * Classifying errors thrown out of Better Auth's `getSession`.
 *
 * `getSession` throws an `APIError` for several unrelated conditions, and the
 * naive handler collapses all of them to 401. That costs real debugging time:
 * the apiKey plugin's per-key rate limit surfaces as "Unauthorized", so an
 * exhausted quota is indistinguishable from a bad key. A throttle must
 * announce itself as a throttle.
 *
 * ⚠️ This is the DIAGNOSTIC half of X2, not the fix. The fix is that the
 * per-key limiter is off in four places (see `../auth.ts`). This exists so
 * that if it ever comes back on, it says so instead of impersonating a
 * revoked credential.
 *
 * MEASURED on better-auth 1.4.19 (2026-09-20), by turning the limiter back on
 * and hammering a key: requests 1-10 return 200, then the plugin throws an
 * APIError out of `getSession`. That APIError carries no HTTP status of its
 * own — `requireAuth`'s catch block cannot tell it from a bad credential, so
 * WITHOUT this classifier it becomes 401. With it, the caller gets a real 429
 * and `{ code: "RATE_LIMITED" }`.
 *
 * That difference is the whole game. The agent maps 401 to
 * `halt_sync_keep_enforcing` — permanent, silent, still enforcing a policy it
 * can never update. It maps 429 to "back off and retry", which is merely
 * degraded. So this file converts an unbounded failure into a bounded one.
 * It does not make an armed key acceptable; places 1-3 are what keep it off.
 *
 * Lifted from homecal, where the per-key limiter bricked the Kindle wall
 * display after ~100 minutes of polling.
 */

/** Shape we care about on Better Auth's APIError; it is not exported cleanly. */
interface MaybeApiError {
  status?: unknown;
  statusCode?: unknown;
  body?: { code?: unknown; message?: unknown } | null;
  message?: unknown;
}

/**
 * True when the error represents "too many requests" rather than a failed
 * credential. Matches defensively — Better Auth has expressed this as a
 * numeric status, a SCREAMING_CASE status string, and a body code across
 * versions, so key off any of them rather than one exact shape.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as MaybeApiError;

  if (e.status === 429 || e.statusCode === 429) return true;

  const haystack = [e.status, e.body?.code, e.body?.message, e.message]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toUpperCase();

  return (
    haystack.includes("TOO_MANY_REQUESTS") ||
    haystack.includes("TOO MANY REQUESTS") ||
    haystack.includes("RATE_LIMIT") ||
    haystack.includes("RATE LIMIT")
  );
}

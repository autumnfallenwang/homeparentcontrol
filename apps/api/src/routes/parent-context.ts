import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { db } from "../db/index.js";
import { householdMembers } from "../db/schema.js";
import type { AuthVariables } from "../middleware/auth.js";

/**
 * Which household is this parent acting in?
 *
 * ⚠️ **Every parent route is scoped by this and nothing else.** A route that
 * takes a `household_id` from the request body would let any authenticated
 * parent read another household's child's day. There is one household today,
 * which is exactly why this has to be structural now: the bug is unreachable
 * until the moment it is catastrophic.
 *
 * `bootstrap.ts` already guarantees the first user owns the first household,
 * so a signed-in parent with no membership row is a genuine inconsistency
 * rather than an expected state.
 */
export type ParentVariables = AuthVariables & { householdId: string; role: string };

export const withHousehold = createMiddleware<{ Variables: ParentVariables }>(async (c, next) => {
  const user = c.get("user");
  const [membership] = await db
    .select({ householdId: householdMembers.householdId, role: householdMembers.role })
    .from(householdMembers)
    .where(eq(householdMembers.userId, user.id))
    .limit(1);

  if (!membership) {
    return c.json({ error: "no household for this account" }, 403);
  }
  c.set("householdId", membership.householdId);
  c.set("role", membership.role);
  return next();
});

/** The house's flat error shape (§5.8). Agent routes use problem+json instead. */
export function fail(c: Context, status: 400 | 403 | 404 | 409 | 422, error: string) {
  return c.json({ error }, status);
}

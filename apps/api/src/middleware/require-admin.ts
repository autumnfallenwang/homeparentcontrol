import { createMiddleware } from "hono/factory";
import type { AuthVariables } from "./auth.js";

/**
 * Must run after `requireAuth` — assumes `user` is on the context.
 * Returns 403 when the user's Better Auth role is not "admin".
 *
 * Note this is the better-auth admin-plugin role on `users.role`, which is
 * about the AUTH system. It is not `household_members.role` (owner | parent),
 * which is about the household. The first human to sign up gets both.
 */
export const requireAdmin = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const user = c.get("user");
  if (user?.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
});

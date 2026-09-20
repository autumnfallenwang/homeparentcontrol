import { count } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

/** better-auth's public email sign-up endpoint. */
const SIGNUP_PATH = "/api/auth/sign-up/email";

/**
 * §5.5 — "After that, signup is closed."
 *
 * The spec states the rule and names no mechanism. This is it: a gate in front
 * of the auth handler that refuses public sign-up once any user exists.
 *
 * Why not better-auth's own `disableSignUp`: it is a static boolean read once
 * at init, so it cannot express "open until the first user, closed after". And
 * why not a database hook: a hook sees the user data, not the request, so it
 * cannot distinguish a public sign-up from an admin-initiated `createUser`.
 *
 * A second parent is added through the admin plugin's
 * `POST /api/auth/admin/create-user`, a different path, which this does not
 * touch. That is deliberate — the household supports `owner` and `parent`
 * members; what is closed is *anonymous* self-service registration.
 *
 * Not cached. Sign-up is rare and a stale "still open" latch is the failure
 * that matters; a COUNT on a table with single-digit rows is free.
 */
export const signupGate = createMiddleware(async (c, next) => {
  if (c.req.method !== "POST" || c.req.path !== SIGNUP_PATH) {
    return next();
  }
  const [result] = await db.select({ value: count() }).from(users);
  if ((result?.value ?? 0) > 0) {
    return c.json(
      { error: "Sign-up is closed. Ask the household owner to create your account." },
      403,
    );
  }
  return next();
});

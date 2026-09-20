import { Hono } from "hono";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";

/**
 * The parent's half of the API, mounted at `/api/parent/v1`.
 *
 * Error shape here is the house's flat `{ error }`, hand-mapped per route.
 * ⚠️ Do NOT add a global `onError` to the root app — it would swallow those.
 * The agent sub-app gets its own scoped handler instead (§5.8).
 *
 * Routes land in phase 2 steps 3–5.
 */
export const parentApp = new Hono<{ Variables: AuthVariables }>();

parentApp.use("*", requireAuth);

import { apiBaseUrl } from "./api.js";

/**
 * Parent sign-in, against better-auth's own routes.
 *
 * ⚠️ **There is no child-facing login here, and there is no route to add
 * one.** §5.8's list of what is deliberately absent from the UI opens with
 * "no child-facing surface of any kind (no login, …)". The only account in
 * this app is a parent's; the child never authenticates to anything, which
 * is why the agent uses a device credential rather than her identity.
 *
 * ⚠️ X4 — this is plain HTTP on the LAN, accepted. The password therefore
 * never appears in a URL, a query string or a log line; better-auth's own
 * `redact` list covers the server side.
 */
async function auth<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The session is a cookie, so the browser has to be allowed to keep it.
    credentials: "include",
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok) {
    throw new Error(parsed?.message ?? `Sign-in failed (${response.status})`);
  }
  return parsed as T;
}

export interface Session {
  user: { id: string; email: string; name: string };
}

export const signIn = (email: string, password: string) =>
  auth<Session>("/sign-in/email", { email, password });

/**
 * ⚠️ Sign-up exists because the FIRST parent has to get in somehow, and
 * `bootstrap.ts` claims the first household for whoever that is. It is not a
 * general registration flow — a second household is not a thing this product
 * has, and `withHousehold` refuses anyone without a membership row.
 */
export const signUp = (email: string, password: string, name: string) =>
  auth<Session>("/sign-up/email", { email, password, name });

export async function currentSession(): Promise<Session | null> {
  const response = await fetch(`${apiBaseUrl()}/api/auth/get-session`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as Session | null;
  return body?.user ? body : null;
}

export async function signOut(): Promise<void> {
  await fetch(`${apiBaseUrl()}/api/auth/sign-out`, {
    method: "POST",
    credentials: "include",
  });
}

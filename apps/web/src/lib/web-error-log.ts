import pkg from "../../package.json";

/**
 * One server-side error in the web app, as ONE JSON line in the house shape —
 * the same fields the API writes, so `{namespace="homeparentcontrol"} | json |
 * level="error"` finds both.
 *
 * ⚠️ Why this exists: Next prints a failed render as a multi-line stack, and
 * Loki stores each line separately — unsearchable and unalertable. homenews
 * has had one such error 650 times a day, unnoticed (checked 2026-09-28).
 *
 * ⚠️ Headers are never logged: they carry the session cookie. The path drops
 * its query string for the same reason.
 */
export function webErrorLine(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath: string; routeType: string },
  now: Date = new Date(),
): string {
  const err = error instanceof Error ? error : new Error(String(error));
  const digest = (error as { digest?: unknown } | null)?.digest;
  return JSON.stringify({
    level: "error",
    time: now.toISOString(),
    service: "hpc-web",
    version: pkg.version,
    event: "web.request_error",
    method: request.method,
    path: request.path.split("?")[0],
    route: context.routePath,
    route_type: context.routeType,
    // Shown on the error page, so a parent's screenshot finds this line.
    ...(typeof digest === "string" ? { digest } : {}),
    err: { type: err.name, message: err.message, stack: err.stack },
    msg: "request failed",
  });
}

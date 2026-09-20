import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { log } from "../lib/logger.js";

/** Structured request logging with a per-request id (correlates via req_id). */
export async function requestLogger(c: Context, next: Next) {
  const reqId = randomUUID();
  const start = Date.now();
  c.set("reqId", reqId);
  await next();
  log.info(
    {
      event: "http.request",
      req_id: reqId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latency_ms: Date.now() - start,
    },
    "request handled",
  );
}

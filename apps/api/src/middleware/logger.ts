import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { log, withLogContext } from "../lib/logger.js";

/** An incoming id is taken only if it looks like one — never a free-text header into Loki. */
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * One `http.request` line per request, in the house shape
 * (`req_id / method / path / status / latency_ms`), and a `req_id` on every
 * line logged while handling it.
 *
 * - ★ A healthy `/health` is not logged. The k8s probes are ≈11,500 lines a
 *   day — 30% of this API's volume, measured 2026-09-28. A FAILING health
 *   check still is.
 * - The level follows the status: 5xx `error`, 4xx `warn`, else `info` — so
 *   `| json | level="error"` finds the failures.
 * - On a 5xx, `err` carries what was thrown (Hono sets `c.error`), stack
 *   included, in the same one JSON line.
 * - `X-Request-Id` is honoured when it looks like an id and echoed back, so a
 *   request can be followed across the web and the API.
 */
export async function requestLogger(c: Context, next: Next) {
  const incoming = c.req.header("x-request-id");
  const reqId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  const start = Date.now();
  c.set("req_id", reqId);
  c.header("X-Request-Id", reqId);

  await withLogContext({ req_id: reqId }, next);

  const status = c.res.status;
  if (c.req.path === "/health" && status === 200) return;

  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  log[level](
    {
      event: "http.request",
      req_id: reqId,
      method: c.req.method,
      path: c.req.path,
      status,
      latency_ms: Date.now() - start,
      ...(status >= 500 && c.error ? { err: c.error } : {}),
    },
    "request handled",
  );
}

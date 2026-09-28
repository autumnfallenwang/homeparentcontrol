# 0012 — Logs are one JSON line per event

- **Status:** accepted
- **Date:** 2026-09-28
- **Deciders:** Aaron Wang

## Context

Alloy ships every pod's stdout to Loki with only `namespace`, `pod`, `container` and `node` as labels.
Everything else is read at query time with `| json`. A live check on 2026-09-28, compared across all
five home apps, found the logs arriving but hard to use:

- **Levels were numbers** (`"level":30`). Loki's `detected_level` only recognises words, so ~100% of
  lines in every app were `unknown`, and Grafana's level colours and filters did nothing.
- **Non-JSON lines.** Every API start printed ~7 lines of `pnpm … start` banner. That broke any `| json`
  count over a range containing a deploy (`JSONParserErr`), and pnpm as PID 1 swallowed SIGTERM.
- **Multi-line errors.** An unhandled throw went to Hono's default `console.error`, so its stack became
  one Loki entry per line. homenews has an error doing exactly this 650×/day, unnoticed.
- **Probe noise.** `/health` was ~11,500 lines/day, 30% of this API's volume.
- **No request context** on a handler's own lines, and none on a background job's.

## Decision

Every log line is **one JSON object in the house shape**
(`level, time, service, version, event, msg` plus fields), with a **static `msg`**:

1. pino writes the level as a word (`formatters.level`).
2. `http.request` is logged at a level chosen by status (5xx `error`, 4xx `warn`). A 5xx carries `err`
   (stack included). A healthy `/health` is not logged. `X-Request-Id` is honoured when it looks like
   an id, and echoed.
3. `AsyncLocalStorage` puts `{ req_id }` on every line inside a request and `{ job, run_id }` on every
   line inside a scheduled run.
4. **A global `onError` exists**, amending §5.8's "there is deliberately NO global `onError`". It only
   answers a *thrown* error nothing handled, returning the house's flat `{ error: "internal" }` 500,
   and logs nothing itself: the request line carries `err`.
   - §5.8's worry was that it would swallow hand-mapped errors. It cannot: those are *returned*
     responses. The agent sub-apps keep their scoped `problem+json` handler, which Hono applies to
     their routes first. A test asserts both.
5. Crashes (`uncaughtException`, `unhandledRejection`) are one `fatal` line, then exit. SIGTERM logs
   `server.shutdown`, drains the scheduler and exits.
6. The API and the migrate Job start with `node` directly, not `pnpm … start`. Better Auth's own output
   goes through pino as `auth.log`.
7. The web app writes one `web.request_error` line per server error (Next's `onRequestError`), and the
   error page shows the `digest` that finds it.

## Consequences

- `{namespace="homeparentcontrol"} | json | level="error"` finds every failure from both containers.
  A startup, verified in the built image, prints no non-JSON lines.
- The shape is still the house's, so a dashboard or query written for one home app keeps working for
  all of them.
- Better Auth's messages are carried as a `detail` field. Only an `Error` argument travels with them,
  never its other arguments, which can be request data.

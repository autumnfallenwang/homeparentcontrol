import {
  ACTION_BY_STATUS,
  HALTING_ACTION,
  type HpcAction,
  type ProblemDocument,
} from "@hpc/contract";
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { log } from "./logger.js";

/**
 * RFC 9457 `application/problem+json` for the agent routes, extended with the
 * one machine-readable member the agent acts on: `hpc_action` (§4.7).
 *
 * ⚠️ Agent routes only. Parent routes keep the house's flat `{ error }` and
 * hand-map their own failures — §5.8 forbids a global `onError` precisely
 * because it would swallow them.
 */

/**
 * The base for problem `type` URIs.
 *
 * ⚠️ Two deliberate departures from §4.7's single example
 * (`https://hpc.arch.internal/problems/device-revoked`):
 *
 * 1. The host is the **API's**, not the UI's. `hpc.arch.internal` is the
 *    Next.js parent UI; the thing emitting these is the API. The spec's
 *    example points at the wrong service.
 * 2. `https://` is kept even though X4 ships plain HTTP everywhere. Per
 *    RFC 9457 §3.1.1 a `type` is an **identifier**, not a location — it need
 *    not dereference, and the scheme is not a claim about transport. Changing
 *    it later would be a breaking change to a stable identifier for no gain.
 */
export const PROBLEM_BASE = "https://homeparentcontrol-api.arch.internal/problems";

/**
 * Every problem this server can emit.
 *
 * ⚠️ The spec has no registry — `device-revoked` is the only `type` value in
 * 2,612 lines. Without one, each handler invents its own URI and the agent has
 * nothing stable to match on. `title` is fixed per `type` (RFC 9457 wants it
 * stable); anything occurrence-specific belongs in `detail`.
 */
export const PROBLEMS = {
  // ── /enroll. Pre-credential: never carry an action. See the guard below.
  enrolCodeUnknown: {
    slug: "enrolment-code-unknown",
    status: 404,
    title: "Unknown enrolment code",
  },
  enrolCodeExpired: {
    slug: "enrolment-code-expired",
    status: 410,
    title: "Enrolment code expired",
  },
  enrolCodeConsumed: {
    slug: "enrolment-code-consumed",
    status: 409,
    title: "Enrolment code already used",
  },
  enrolInvalid: { slug: "enrolment-invalid", status: 400, title: "Malformed enrolment request" },

  // ── Authenticated agent routes.
  unauthorized: { slug: "device-unauthorized", status: 401, title: "Device credential rejected" },
  deviceRevoked: { slug: "device-revoked", status: 401, title: "Device credential revoked" },
  scopeViolation: { slug: "scope-violation", status: 403, title: "Out of scope for this device" },
  policyNotFound: { slug: "policy-not-found", status: 404, title: "No policy compiled yet" },
  malformed: { slug: "malformed-request", status: 400, title: "Malformed request" },
  payloadTooLarge: { slug: "batch-too-large", status: 413, title: "Batch too large" },
  rateLimited: { slug: "rate-limited", status: 429, title: "Too many requests" },
  // 409 maps to no action in §4.7's table, so the handler names `backoff`
  // explicitly: the desired item is re-sent next tick and succeeds once the
  // previous overlap window closes.
  rotationInProgress: {
    slug: "rotation-in-progress",
    status: 409,
    title: "A credential rotation is already in flight",
  },
  internal: { slug: "internal-error", status: 500, title: "Internal error" },
} as const;

export type ProblemKey = keyof typeof PROBLEMS;

/**
 * ★ The guard.
 *
 * §4.7's status table is written globally: `410 → decommission`, the one
 * `hpc_action` that stops enforcement. But §5.5 also uses `410` on
 * `POST /enroll` to mean "your code expired" — and `/enroll` is the only
 * unauthenticated endpoint in the system. Read literally, the single wire
 * signal that stops enforcement is reachable with no credential at all.
 *
 * In practice nothing is enrolled at that moment so there is nothing to stop,
 * but the spec never says that and a future handler could make it true. So the
 * rule is structural rather than incidental: **pre-credential responses carry
 * no `hpc_action`.** `problem.test.ts` asserts no unauthenticated problem can
 * ever produce `decommission`.
 */
export const PRE_CREDENTIAL_PROBLEMS = [
  "enrolCodeUnknown",
  "enrolCodeExpired",
  "enrolCodeConsumed",
  "enrolInvalid",
] as const satisfies readonly ProblemKey[];

const preCredential = new Set<ProblemKey>(PRE_CREDENTIAL_PROBLEMS);

/**
 * Build a problem document.
 *
 * `hpc_action` is derived from the status via the contract's table, except for
 * pre-credential problems, which never carry one. Pass `action: null` to
 * suppress it explicitly elsewhere.
 */
export function buildProblem(
  key: ProblemKey,
  c: Context,
  opts: { detail?: string; action?: HpcAction | null } = {},
): ProblemDocument {
  const spec = PROBLEMS[key];
  const action =
    opts.action !== undefined
      ? opts.action
      : preCredential.has(key)
        ? null
        : ACTION_BY_STATUS[spec.status];

  const doc: ProblemDocument = {
    type: `${PROBLEM_BASE}/${spec.slug}`,
    title: spec.title,
    status: spec.status,
    instance: c.req.path,
  };
  if (opts.detail) doc.detail = opts.detail;
  if (action) doc.hpc_action = action;
  return doc;
}

/** Send a problem response with the RFC 9457 media type. */
export function problem(
  c: Context,
  key: ProblemKey,
  opts: { detail?: string; action?: HpcAction | null } = {},
): Response {
  const doc = buildProblem(key, c, opts);
  return c.json(doc, doc.status as 400, {
    "content-type": "application/problem+json",
  });
}

/**
 * A typed throw that the agent `onError` turns into a problem response, so a
 * handler deep in a transaction can fail without threading a Context through.
 */
export class ProblemError extends Error {
  constructor(
    readonly key: ProblemKey,
    readonly detail?: string,
    /**
     * Override the status-derived action. The only legitimate use is the
     * authenticated, parent-initiated decommission — which must be stated
     * deliberately at its one call site, never inherited from a status code.
     */
    readonly opts?: { action?: HpcAction | null },
  ) {
    super(`${key}${detail ? `: ${detail}` : ""}`);
    this.name = "ProblemError";
  }
}

/**
 * The `onError` for BOTH agent instances — `agentApp` and `enrolApp`.
 *
 * ⚠️ Mounted per instance, never globally. Hono's `onError` is per-instance
 * and cannot be scoped to a path prefix, which is why the agent routes live on
 * their own Hono instances at all.
 */
export const agentOnError: ErrorHandler = (err, c) => {
  if (err instanceof ProblemError) {
    return problem(c, err.key, { detail: err.detail, action: err.opts?.action });
  }
  if (err instanceof HTTPException && err.status === 429) {
    return problem(c, "rateLimited");
  }

  // Unexpected. Log it with the request id, tell the agent to back off, and
  // never leak the message — 5xx maps to `backoff` and enforcement continues.
  log.error(
    { event: "agent.unhandled_error", req_id: c.get("req_id"), path: c.req.path, err },
    "unhandled error on an agent route",
  );
  return problem(c, "internal", { action: "backoff" });
};

/** Exported so the guard test can assert on it without importing the contract twice. */
export { HALTING_ACTION };

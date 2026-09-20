import { z } from "zod";

/**
 * RFC 9457 `application/problem+json`, extended with exactly one
 * machine-readable member: `hpc_action` (§4.7).
 */

/**
 * What the agent should DO about a failure. Eight values.
 *
 * ⚠️ Exactly one of them stops enforcement: `decommission`. Every other error,
 * timeout and silence leaves enforcement running — see X1b. A revoked
 * credential is an *administrative* state, orthogonal to enforcement;
 * treating 401 as "stop" would make revocation a bypass.
 */
export const HPC_ACTIONS = [
  "drop_batch",
  "halt_sync_keep_enforcing",
  "reenroll",
  "decommission",
  "halve_batch",
  "drop_event",
  "upgrade_required",
  "backoff",
] as const;

export const hpcAction = z.enum(HPC_ACTIONS);
export type HpcAction = z.infer<typeof hpcAction>;

/** The single action that stops enforcement. Kept as a named export so the check is greppable. */
export const HALTING_ACTION: HpcAction = "decommission";

/**
 * Status code → action (§4.7). `5xx`, timeouts, DNS and TCP failures all map
 * to `backoff` and are not in this table.
 *
 * ⚠️ Scoped to the authenticated agent endpoints. On `POST /enroll`, `409` and
 * `410` mean enrolment-code conflict and expiry respectively (§5.5), NOT
 * `reenroll`/`decommission`. The spec's table does not scope itself per
 * endpoint; that ambiguity is recorded, not resolved here.
 */
export const ACTION_BY_STATUS: Readonly<Record<number, HpcAction>> = Object.freeze({
  400: "drop_batch",
  401: "halt_sync_keep_enforcing",
  403: "halt_sync_keep_enforcing",
  409: "reenroll",
  410: "decommission",
  413: "halve_batch",
  422: "drop_event",
  426: "upgrade_required",
  429: "backoff",
});

export const problemDocument = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  hpc_action: hpcAction.optional(),
});
export type ProblemDocument = z.infer<typeof problemDocument>;

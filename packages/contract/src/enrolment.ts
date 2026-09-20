import { z } from "zod";
import { instant, uuid } from "./primitives.js";

/**
 * `POST /api/agent/v1/enroll` — one-time code exchanged for a durable
 * credential. The only unauthenticated write endpoint (§4.5, §5.5).
 *
 * ⚠️ THE REQUEST BODY IS NOT SPECIFIED ANYWHERE IN THE DESIGN DOCUMENT.
 * §4.5 names the endpoint, §5.5 describes the server-side handler, and the CLI
 * is `hpc-agent enroll --server <url> --code HPC-K7QM-3ZTD-9F2W` — but no JSON
 * shape exists. The handler captures `consumed_ip` and
 * `consumed_hardware_uuid`, so the body plausibly carries the code plus device
 * facts, and that is exactly the kind of guess R2 makes permanent.
 *
 * Left deliberately open below. Phase 2 defines it from the real handler.
 */

/** Display form of the one-time code, e.g. `HPC-K7QM-3ZTD-9F2W` (Crockford base32, 60 bits, 60-min TTL). */
export const enrolmentCode = z
  .string()
  .regex(/^HPC(-[0-9A-HJKMNP-TV-Z]{4}){3}$/, "expected HPC-XXXX-XXXX-XXXX (Crockford base32)");

/** TODO(phase 2): define from the real handler. Open so nothing is invented here. */
export const enrolmentRequest = z.looseObject({
  code: enrolmentCode,
});
export type EnrolmentRequest = z.infer<typeof enrolmentRequest>;

/** ⚠️ Element shape unspecified in the document. Opaque until phase 2. */
export const policySigningKey = z.looseObject({});

export const enrolmentResponse = z.object({
  device_id: uuid,
  credential: z.object({
    token: z.string(),
    key_id: z.string(),
    issued_at: instant,
    rotate_after: instant.optional(),
  }),
  policy_signing_keys: z.array(policySigningKey).default([]),
  base_url: z.string().optional(),
});
export type EnrolmentResponse = z.infer<typeof enrolmentResponse>;

/**
 * `GET /api/agent/v1/health` — unauthenticated liveness of the SERVER (§4.5).
 * Field names are given; types are not. `contract_versions` is plural.
 */
export const serverHealth = z.object({
  status: z.string(),
  contract_versions: z.array(z.int()).default([]),
  server_time: instant,
});
export type ServerHealth = z.infer<typeof serverHealth>;

import { z } from "zod";
import { instant, uuid } from "./primitives.js";

/**
 * `POST /api/agent/v1/enroll` — one-time code exchanged for a durable
 * credential. The only unauthenticated write endpoint (§4.5, §5.5).
 *
 * ⚠️ The request body is not specified anywhere in the design document — §4.5
 * names the endpoint and §5.5 describes the handler, but no JSON shape exists.
 * Defined here in phase 2 from what the real handler needs, as the earlier
 * TODO said to: the code, plus the device facts the handler persists. Every
 * optional field below is an existing `devices` column.
 *
 * ⚠️ R2 — additive only. Nothing here may be renamed or removed.
 */

/** Display form of the one-time code, e.g. `HPC-K7QM-3ZTD-9F2W` (Crockford base32, 60 bits, 60-min TTL). */
export const enrolmentCode = z
  .string()
  .regex(/^HPC(-[0-9A-HJKMNP-TV-Z]{4}){3}$/, "expected HPC-XXXX-XXXX-XXXX (Crockford base32)");

export const enrolmentRequest = z.object({
  code: enrolmentCode,
  /**
   * Required: it is the physical identity that survives an OS reinstall, and
   * the re-issue guard (§5.5) compares it against `consumed_hardware_uuid`.
   */
  hardware_uuid: z.string().min(1),
  hostname: z.string().optional(),
  model: z.string().optional(),
  os_version: z.string().optional(),
  arch: z.string().optional(),
  agent_version: z.string().optional(),
});
export type EnrolmentRequest = z.infer<typeof enrolmentRequest>;

/**
 * A policy-signing public key, as a JWK (📄 RFC 7517).
 *
 * ⚠️ The element shape is never given in the design document — the field is
 * named once, in the enrolment response, and nothing says whether an element
 * is a JWK, a raw key or a PEM. Defined here in phase 2.
 *
 * `kid` is the RFC 7638 thumbprint of the key, and is what the JWS header's
 * `kid` carries — that pairing is what lets an agent pick the right key. The
 * spec specifies neither, and gives `kid` no source at all.
 *
 * ⚠️ Members are typed as plain strings, not literals, deliberately (R1): an
 * agent must be able to parse a key whose `alg` it does not recognise and skip
 * it, rather than fail to parse the enrolment response. Today the server only
 * ever emits `kty: "OKP"`, `crv: "Ed25519"`, `alg: "EdDSA"`, `use: "sig"`.
 */
export const policySigningKey = z.looseObject({
  kid: z.string(),
  kty: z.string(),
  crv: z.string(),
  /** base64url public key bytes. */
  x: z.string(),
  alg: z.string(),
  use: z.string().optional(),
});
export type PolicySigningKey = z.infer<typeof policySigningKey>;

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

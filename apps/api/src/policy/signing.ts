import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import type { PolicySigningKey } from "@hpc/contract";
import { config } from "../config.js";

/**
 * Ed25519 policy signing (A.16) — a compact JWS the agent verifies over the
 * raw bytes *before* parsing the payload, which is why there is no
 * canonicalisation question on the signature path.
 *
 * ⚠️ Node does Ed25519 natively; §5.8 is explicit that no library is needed,
 * and none is used. A compact JWS is three base64url segments.
 */

export class SigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningKeyError";
  }
}

export interface SigningKey {
  privateKey: KeyObject;
  /** The public half, as it goes out in the enrolment response. */
  publicJwk: PolicySigningKey;
  /** RFC 7638 thumbprint. Also the JWS header's `kid`. */
  kid: string;
}

/**
 * RFC 7638 JWK thumbprint — sha256 over the required members only, in
 * lexicographic order, with no whitespace.
 *
 * ⚠️ This is a decision, not a transcription. The spec puts a `kid` in the JWS
 * header and a `signing_key_id` column in `policy_versions`, and says nothing
 * whatsoever about where the value comes from — there is one env var, no key
 * table, and no derivation rule. A thumbprint needs no second secret, no
 * column and no coordination: any holder of the public key computes the same
 * id, which is exactly what makes `policy_signing_keys[]` usable for key
 * selection.
 */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string }): string {
  const required = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(required, "utf8").digest("base64url");
}

/**
 * Parse `POLICY_SIGNING_KEY` into a usable key.
 *
 * ⚠️ Format is **PKCS#8 PEM** — the spec never states one (no PEM, JWK, base64
 * or DER anywhere), so this picks the form `createPrivateKey` reads natively.
 * Generate with: `openssl genpkey -algorithm ed25519`.
 *
 * Pure: takes the PEM rather than reading config, so tests need no env.
 */
export function loadSigningKey(pem: string): SigningKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (err) {
    throw new SigningKeyError(
      `POLICY_SIGNING_KEY is not a readable private key: ${(err as Error).message}`,
    );
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new SigningKeyError(
      `POLICY_SIGNING_KEY must be Ed25519, got ${privateKey.asymmetricKeyType ?? "unknown"}`,
    );
  }

  const raw = createPublicKey(privateKey).export({ format: "jwk" }) as {
    crv: string;
    kty: string;
    x: string;
  };
  const kid = jwkThumbprint(raw);

  return {
    privateKey,
    kid,
    publicJwk: { kid, kty: raw.kty, crv: raw.crv, x: raw.x, alg: "EdDSA", use: "sig" },
  };
}

let cached: SigningKey | null | undefined;

/**
 * The process's signing key, or `null` when running unsigned.
 *
 * Unsigned is a deliberate, opted-into state — `index.ts` refuses to start
 * without either a key or `ALLOW_UNSIGNED_POLICY=1`, because the spec gives
 * `policy_unsigned` no health consequence at all and a control plane that
 * silently stopped signing would look identical to one that signs.
 */
export function getSigningKey(): SigningKey | null {
  if (cached === undefined) {
    cached = config.policySigningKey ? loadSigningKey(config.policySigningKey) : null;
  }
  return cached;
}

/** Test seam — the key is memoised for the process lifetime. */
export function resetSigningKey(): void {
  cached = undefined;
}

const b64u = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/**
 * Sign a policy document as a compact JWS: `header.payload.signature`.
 *
 * The payload is the serialised document, embedded in the token, so the agent
 * verifies exactly the bytes it then parses. ⚠️ `policy_versions.document` is
 * `jsonb` and cannot reproduce these bytes — once signing is on, the JWS is
 * the authority and that column is a readable copy.
 */
export function signPolicy(document: unknown, key: SigningKey): string {
  const header = b64u(JSON.stringify({ alg: "EdDSA", typ: "JOSE", kid: key.kid }));
  const payload = b64u(JSON.stringify(document));
  const signingInput = `${header}.${payload}`;
  // `null` algorithm: Ed25519 signs the message directly, never a pre-hash.
  const signature = sign(null, Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${b64u(signature)}`;
}

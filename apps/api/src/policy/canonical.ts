import { createHash } from "node:crypto";
import type { PolicyDocument } from "@hpc/contract";

/**
 * Content addressing for the compiled policy.
 *
 * ⚠️ The spec says two things that look contradictory and are not. A.16 and
 * §4.2 insist there is "no JSON-canonicalisation question", because the agent
 * verifies the JWS over the raw bytes and only THEN parses. True — for the
 * SIGNATURE. But §5.2 and §5.6 also specify `sha256(canonical JSON)` as the
 * change-detection key, and that is a content address: it must be stable
 * across two independent serialisations of equal content, or §5.6's
 * `if hash == currentVersion.documentHash: RETURN unchanged` never fires.
 *
 * So: canonicalisation here is for the HASH only. It never touches the bytes
 * that get signed.
 */

/** Recursively key-sorted, no whitespace. The hash's input, and only that. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * ★ The three fields that must NOT be hashed.
 *
 * §5.6's churn-killer compares the new hash against the stored one. But §4.3's
 * document carries `issued_at`, `not_before` and `policy_version`, and all
 * three change on every single compile. Hash the document whole and the
 * comparison can never be true, the ladder never short-circuits, and
 * milestone 01's exit criterion — "emits nothing when the content hash is
 * unchanged" — is not merely unmet but unmeetable.
 *
 * The spec never notices this. Excluding them is the only construction in
 * which §5.6's short-circuit is live code.
 */
export const CONTENT_HASH_EXCLUDED = ["policy_version", "issued_at", "not_before"] as const;

/**
 * sha256 over the document's CONTENT — what the parent authored — rather than
 * over the envelope. Lands in `policy_versions.document_hash`.
 */
export function contentHash(doc: PolicyDocument): string {
  const content: Record<string, unknown> = { ...doc };
  for (const field of CONTENT_HASH_EXCLUDED) delete content[field];
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

/**
 * `W/"pol-<hash12>-v<version>"`.
 *
 * ⚠️ TWELVE hash characters. §5.2's column comment says 12; §4.2's two worked
 * examples both show 8. The schema is the more specific statement and is what
 * this repo already recorded in step 1, so 12 it is — consistently, because
 * the value is an opaque cache key and the only thing that matters is that one
 * spelling exists.
 */
export function etagFor(hash: string, version: number): string {
  return `W/"pol-${hash.slice(0, 12)}-v${version}"`;
}

/** Separator for `deterministicUuid` parts — NUL, which cannot occur in an id. */
const PART_SEPARATOR = "\0";

/**
 * A UUID derived from its inputs rather than generated.
 *
 * Synthesised overrides (holidays, calendar exceptions) have no database row
 * and therefore no id, but the contract types `override.id` as a UUID and the
 * content hash covers it. A random id would change on every compile, so every
 * compile would produce a "new" version and the churn-killer would be defeated
 * from the other direction. This makes the id a function of what produced it.
 *
 * sha256 rather than UUIDv5's sha1, with the version nibble set to 8 — the
 * RFC 9562 custom form. Verified to satisfy the contract's `z.uuid()`.
 */
export function deterministicUuid(...parts: Array<string | number>): string {
  const h = createHash("sha256").update(parts.join(PART_SEPARATOR), "utf8").digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x80; // version 8
  h[8] = ((h[8] as number) & 0x3f) | 0x80; // variant 10
  const hex = h.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

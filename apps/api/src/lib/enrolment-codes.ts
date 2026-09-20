import { createHash, randomBytes } from "node:crypto";

/**
 * The one-time enrolment code — `HPC-K7QM-3ZTD-9F2W` (§5.5).
 *
 * Crockford base32, 60 bits, 60-minute TTL. Crockford is the point: the parent
 * reads this off a screen and types it into a terminal on another machine, so
 * the alphabet omits I, L, O and U, and decoding folds the look-alikes back
 * (`I`/`l` → `1`, `O` → `0`) rather than rejecting them.
 *
 * ⚠️ Only `code_hash` is stored. `code_hint` keeps the first group so the
 * parent UI can say *which* code, without the row being enough to redeem it.
 */

/** Crockford's alphabet: no I, L, O or U. Matches the contract's regex. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 3;
const GROUP_LEN = 4;

/** ⚖️ 60 minutes, per §5.5's interruption table — not T4's 15. */
export const ENROLMENT_TTL_MINUTES = 60;

/** ⚖️ Five wrong attempts against a *known* code burn the row (§5.4). */
export const MAX_ENROLMENT_ATTEMPTS = 5;

/**
 * A fresh code, in display form.
 *
 * Rejection sampling over the 32-char alphabet: 256 is not a multiple of 32's
 * byte-boundary needs, but 5 bits per char is, so bytes are consumed 5 bits at
 * a time from a wider pool. Simpler and unbiased: take one byte per character
 * and discard values ≥ 256 - (256 % 32), which is never (256 % 32 === 0), so
 * a plain mask is already uniform.
 */
export function generateEnrolmentCode(): string {
  const chars = GROUPS * GROUP_LEN;
  const bytes = randomBytes(chars);
  let out = "";
  for (let i = 0; i < chars; i++) {
    // 256 % 32 === 0, so masking to 5 bits is uniform with no rejection needed.
    out += ALPHABET[(bytes[i] as number) & 0x1f];
  }
  const groups = Array.from({ length: GROUPS }, (_, i) =>
    out.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN),
  );
  return `HPC-${groups.join("-")}`;
}

/**
 * Fold a typed code back to its canonical display form, or `null` if it cannot
 * be one.
 *
 * Tolerant on input, exact on output: case, whitespace and hyphenation are all
 * forgiven, and Crockford's look-alikes are mapped. A parent mistyping `O` for
 * `0` should not produce a 404 they cannot diagnose.
 */
export function normaliseEnrolmentCode(input: string): string | null {
  const folded = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/^HPC/, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");

  if (folded.length !== GROUPS * GROUP_LEN) return null;
  if (!/^[0-9A-HJKMNP-TV-Z]+$/.test(folded)) return null;

  const groups = Array.from({ length: GROUPS }, (_, i) =>
    folded.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN),
  );
  return `HPC-${groups.join("-")}`;
}

/**
 * sha256 of the **normalised** code. The only form that reaches the database.
 *
 * ⚠️ Hash the normalised code, never the raw input, or two spellings of one
 * code produce two hashes and the `UNIQUE(code_hash)` single-use guarantee
 * quietly stops guaranteeing anything.
 */
export function hashEnrolmentCode(normalised: string): string {
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/** `HPC-K7QM` — which code this is, safe to show and useless to redeem. */
export function enrolmentCodeHint(normalised: string): string {
  return normalised.slice(0, 8);
}

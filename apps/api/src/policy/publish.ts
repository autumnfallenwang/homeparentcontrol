import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices, policyVersions } from "../db/schema.js";
import { log } from "../lib/logger.js";
import { contentHash, etagFor } from "./canonical.js";
import { compilePolicy } from "./compile.js";
import { gatherCompilerInput } from "./gather.js";
import { getSigningKey, signPolicy } from "./signing.js";
import { PolicyCompileError, type PublishReason, type PublishResult } from "./types.js";

export interface PublishArgs {
  deviceId: string;
  reason: PublishReason;
  /** Null for enrolment and any scheduled recompile — neither has a user. */
  publishedBy?: string | null;
  /** Injectable for tests; defaults to now. */
  now?: Date;
  /** Join an outer transaction — /enroll compiles v1 inside its own. */
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0];
}

/**
 * Compile a device's policy and persist it — unless nothing changed.
 *
 * §5.6: `if hash == currentVersion.documentHash: RETURN unchanged`, which it
 * calls the thing that "kills recompile churn". Milestone 01 states the same
 * property as an exit criterion: the compiler "emits nothing when the content
 * hash is unchanged". This is where that lives; `compilePolicy` itself is pure
 * and cannot decide not to emit.
 *
 * Signing happens here, over the parsed document, so the bytes in the JWS are
 * exactly the contract-conformant ones the agent will parse after verifying.
 *
 * ⚠️ When no key is configured, `jws` and `signing_key_id` stay null and the
 * contract's third sync-envelope variant (`document` in the clear, agent logs
 * `policy_unsigned`) carries it. That state is reachable only by setting
 * ALLOW_UNSIGNED_POLICY=1 — `index.ts` refuses to start otherwise.
 */
export async function publishPolicy(args: PublishArgs): Promise<PublishResult> {
  const now = args.now ?? new Date();
  const run = async (tx: NonNullable<PublishArgs["tx"]>): Promise<PublishResult> => {
    // Serialise publishes per device. `UNIQUE(device_id, version)` is the only
    // thing protecting the version sequence and the spec names no locking
    // strategy, so two concurrent grants on one Mac would race to the same
    // `next` and one would die on the constraint. Locking the device row is
    // cheap and makes the read-then-insert atomic.
    const [locked] = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.id, args.deviceId))
      .for("update");
    if (!locked) throw new PolicyCompileError("device not found", args.deviceId);

    const input = await gatherCompilerInput(args.deviceId, now);
    const document = compilePolicy(input);
    const hash = contentHash(document);

    const [current] = await tx
      .select({
        version: policyVersions.version,
        documentHash: policyVersions.documentHash,
        etag: policyVersions.etag,
      })
      .from(policyVersions)
      .where(eq(policyVersions.deviceId, args.deviceId))
      .orderBy(desc(policyVersions.version))
      .limit(1);

    if (current && current.documentHash === hash) {
      // The churn-killer. No row, no ETag change, so every agent holding this
      // policy gets a 304 and nothing re-downloads.
      return { status: "unchanged", version: current.version, etag: current.etag };
    }

    const version = (current?.version ?? 0) + 1;
    const etag = etagFor(hash, version);

    // A.16 — compact JWS over the document. `kid` is the key's RFC 7638
    // thumbprint, which is also what `policy_signing_keys[]` carries, and is
    // how the agent picks the right key to verify with.
    const key = getSigningKey();
    const jws = key ? signPolicy(document, key) : null;

    await tx.insert(policyVersions).values({
      householdId: input.household.id,
      deviceId: args.deviceId,
      policySetId: input.policySet.id,
      version,
      // ⚠️ jsonb does not preserve key order, so this is the readable copy,
      // not a byte-exact record. Once signing exists the JWS is the authority
      // and this column is for psql archaeology.
      document,
      documentHash: hash,
      jws,
      signingKeyId: key?.kid ?? null,
      etag,
      issuedAt: now,
      notBefore: now,
      confirmImmediateEffect: document.confirm_immediate_effect,
      publishedBy: args.publishedBy ?? null,
      publishReason: args.reason,
    });

    // Denormalised so the device page is one read.
    await tx
      .update(devices)
      .set({ policySetId: input.policySet.id, updatedAt: sql`now()` })
      .where(eq(devices.id, args.deviceId));

    log.info(
      {
        event: "policy.published",
        device_id: args.deviceId,
        version,
        reason: args.reason,
        overrides: document.overrides.length,
        signed: jws !== null,
      },
      "compiled a new policy version",
    );

    return { status: "published", version, etag, contentHash: hash };
  };

  return args.tx ? run(args.tx) : db.transaction(run);
}

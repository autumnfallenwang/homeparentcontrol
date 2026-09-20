import { type EnrolmentResponse, enrolmentRequest } from "@hpc/contract";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { apikeys, devices, enrollments, households, tripwires } from "../db/schema.js";
import { mintDeviceKey } from "../lib/device-keys.js";
import {
  hashEnrolmentCode,
  MAX_ENROLMENT_ATTEMPTS,
  normaliseEnrolmentCode,
} from "../lib/enrolment-codes.js";
import { log } from "../lib/logger.js";
import { agentOnError, ProblemError } from "../lib/problem.js";
import { publishPolicy } from "../policy/publish.js";
import { getSigningKey } from "../policy/signing.js";

/**
 * `POST /api/agent/v1/enroll` — a one-time code exchanged for a durable
 * credential (§5.5). **The only unauthenticated write endpoint in the system.**
 *
 * ⚠️ Its own Hono instance, deliberately. `agentApp` carries
 * `use("*", requireAuth)`, and an unauthenticated route living there would be
 * unauthenticated only because of handler registration order — exactly the
 * kind of invariant a later edit breaks in silence. A separate instance cannot
 * be broken that way.
 *
 * ⚠️ Responses from here NEVER carry an `hpc_action`. §4.7's table is written
 * globally and maps 410 to `decommission`, the one action that stops
 * enforcement, while §5.5 uses 410 here for an expired code. See
 * `lib/problem.ts` — the rule is structural, and `problem.test.ts` asserts it.
 */
export const enrolApp = new Hono();

enrolApp.onError(agentOnError);

enrolApp.post("/", async (c) => {
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object")
    throw new ProblemError("enrolInvalid", "expected a JSON body");

  // ⚠️ Normalise BEFORE validating. The contract's `code` regex documents the
  // canonical display form, which is right for the agent author — but the
  // server must still be a tolerant reader (R1). A parent typing
  // `hpc-k7qm-3ztd-9f2w`, or pasting it with spaces, must not get a 400 they
  // cannot diagnose. The canonical form is what gets hashed either way.
  const normalised = typeof raw.code === "string" ? normaliseEnrolmentCode(raw.code) : null;
  if (!normalised) throw new ProblemError("enrolInvalid", "code is not a valid enrolment code");

  const parsed = enrolmentRequest.safeParse({ ...raw, code: normalised });
  if (!parsed.success) {
    throw new ProblemError("enrolInvalid", parsed.error.issues[0]?.message);
  }
  const body = parsed.data;
  const codeHash = hashEnrolmentCode(normalised);

  const consumedIp =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined;

  /**
   * ⚠️ `mintDeviceKey` goes through better-auth's own drizzle adapter, which
   * does NOT enlist in our transaction. So a failure after the mint would
   * leave an API key that no device row references — a credential that works
   * and that nobody can see. Every key minted below is recorded here and
   * revoked if the transaction does not commit.
   */
  const minted: string[] = [];

  let result: EnrolmentResponse | null;
  try {
    result = await db.transaction(async (tx) => {
      // ── The single-use guarantee: a conditional UPDATE, not a
      // read-then-write. Atomic under any concurrency, with no advisory lock
      // and no isolation level to get wrong. Two Macs racing one code:
      // exactly one gets a row back.
      const claimed = await tx
        .update(enrollments)
        .set({
          consumedAt: sql`now()`,
          consumedIp: consumedIp ?? null,
          consumedHardwareUuid: body.hardware_uuid,
        })
        .where(
          and(
            eq(enrollments.codeHash, codeHash),
            isNull(enrollments.consumedAt),
            sql`${enrollments.expiresAt} > now()`,
          ),
        )
        .returning({ id: enrollments.id, deviceId: enrollments.deviceId });

      if (claimed.length === 0) return null;

      const row = claimed[0] as { id: string; deviceId: string };
      return await issue(tx, row.deviceId, body, minted);
    });
  } catch (err) {
    if (minted.length > 0) {
      await db
        .delete(apikeys)
        .where(inArray(apikeys.id, minted))
        .catch((cleanupErr) =>
          log.error(
            { event: "enrolment.orphaned_key", key_ids: minted, err: cleanupErr },
            "could not revoke a key minted by a failed enrolment",
          ),
        );
    }
    throw err;
  }

  // Zero rows claimed is three different situations. Disambiguating them is
  // the whole of §5.5's interruption table — and it happens OUTSIDE the claim
  // transaction, because `attempts` must survive the rejection.
  if (result === null) {
    result = await rejectOrReissue(codeHash, body, minted);
  }

  return c.json(result, 201);
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface IssueBody {
  hardware_uuid: string;
  hostname?: string;
  model?: string;
  os_version?: string;
  arch?: string;
  agent_version?: string;
}

/**
 * The conditional UPDATE matched nothing. Work out which of §5.5's cases it is.
 *
 * ⚠️ `attempts` is incremented here, for a code that EXISTS but was rejected.
 * As literally specified the counter is unreachable — a wrong code hashes to
 * nothing, so there is no row to increment — and a wrong code is instead
 * covered by the IP limiter (5/min, 20/h), which is what it is for. Recorded
 * rather than papered over.
 */
async function rejectOrReissue(
  codeHash: string,
  body: IssueBody,
  minted: string[],
): Promise<EnrolmentResponse> {
  const hardwareUuid = body.hardware_uuid;
  const [row] = await db.select().from(enrollments).where(eq(enrollments.codeHash, codeHash));

  // No such code. §5.4: a bad code is a 404/400, NEVER a 401, so it can never
  // be confused with a revoked credential.
  if (!row) throw new ProblemError("enrolCodeUnknown");

  // ⚠️ OUTSIDE any transaction that is about to throw. An earlier version
  // incremented this inside the claim transaction, so every rejection rolled
  // the counter straight back and the row could never burn. The integration
  // test caught it; keep this write unconditional and standalone.
  await db
    .update(enrollments)
    .set({ attempts: sql`${enrollments.attempts} + 1` })
    .where(eq(enrollments.id, row.id));

  if (row.attempts + 1 >= MAX_ENROLMENT_ATTEMPTS) {
    log.warn(
      { event: "enrolment.burned", enrolment_id: row.id, device_id: row.deviceId },
      "enrolment code burned after repeated failures",
    );
    throw new ProblemError("enrolCodeConsumed", "too many attempts; ask for a new code");
  }

  if (row.expiresAt <= new Date()) throw new ProblemError("enrolCodeExpired");
  if (!row.consumedAt) throw new ProblemError("enrolCodeConsumed");

  // ── The re-issue case: the agent crashed after our commit but before it
  // wrote credential.json, so it is asking again with the same code. Four
  // conditions, ALL required. Any one missing is a 409.
  const sameHardware = row.consumedHardwareUuid === hardwareUuid;
  const insideTtl = row.expiresAt > new Date();
  const [key] = await db
    .select({ id: apikeys.id, lastRequest: apikeys.lastRequest })
    .from(apikeys)
    .innerJoin(devices, eq(devices.apiKeyId, apikeys.id))
    .where(eq(devices.id, row.deviceId));
  const keyNeverUsed = key ? key.lastRequest === null : false;

  if (!(sameHardware && insideTtl && key && keyNeverUsed)) {
    throw new ProblemError("enrolCodeConsumed");
  }

  log.info(
    { event: "enrolment.reissued", device_id: row.deviceId },
    "re-issuing a credential the agent never stored",
  );

  return await db.transaction(async (tx) => {
    // Revoke the credential the agent never managed to store, then mint fresh.
    await tx.delete(apikeys).where(eq(apikeys.id, key.id));
    await tx
      .update(enrollments)
      .set({ reissueCount: sql`${enrollments.reissueCount} + 1` })
      .where(eq(enrollments.id, row.id));
    return await issue(tx, row.deviceId, body, minted);
  });
}

/** Mint the credential, record the device's facts, and compile policy v1. */
async function issue(
  tx: Tx,
  deviceId: string,
  body: IssueBody,
  minted: string[],
): Promise<EnrolmentResponse> {
  const [device] = await tx
    .select({
      id: devices.id,
      householdId: devices.householdId,
      label: devices.label,
      hardwareUuid: devices.hardwareUuid,
    })
    .from(devices)
    .where(eq(devices.id, deviceId));
  if (!device) throw new ProblemError("enrolCodeUnknown", "the device for this code is gone");

  const [household] = await tx
    .select({ serviceUserId: households.serviceUserId })
    .from(households)
    .where(eq(households.id, device.householdId));
  if (!household?.serviceUserId) {
    // A.21 — device keys hang off the household's service user. Without one
    // there is nothing to own the credential.
    throw new Error(`household ${device.householdId} has no service user`);
  }

  // ⚠️ A hardware-UUID change on re-enrol is ACCEPTED and raises a tripwire,
  // never refused (§5.5) — a logic board swap must not brick enrolment.
  if (device.hardwareUuid && device.hardwareUuid !== body.hardware_uuid) {
    await tx
      .insert(tripwires)
      .values({
        householdId: device.householdId,
        deviceId,
        kind: "hardware_uuid_mismatch",
        detail: `${device.hardwareUuid} -> ${body.hardware_uuid}`,
      })
      .onConflictDoUpdate({
        target: [tripwires.deviceId, tripwires.kind],
        set: { occurrences: sql`${tripwires.occurrences} + 1`, lastSeenAt: sql`now()` },
      });
  }

  const credential = await mintDeviceKey({
    serviceUserId: household.serviceUserId,
    deviceId,
    householdId: device.householdId,
    label: device.label,
  });
  minted.push(credential.keyId);

  await tx
    .update(devices)
    .set({
      status: "enrolled",
      hardwareUuid: body.hardware_uuid,
      apiKeyId: credential.keyId,
      hostname: body.hostname ?? null,
      model: body.model ?? null,
      osVersion: body.os_version ?? null,
      arch: body.arch ?? null,
      agentVersion: body.agent_version ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(devices.id, deviceId));

  // §5.5 — policy v1 inside the same transaction, "so the very first tick gets
  // a real policy rather than a 404".
  await publishPolicy({ deviceId, reason: "enrol", tx });

  const signingKey = getSigningKey();
  return {
    device_id: deviceId,
    credential: {
      token: credential.token,
      key_id: credential.keyId,
      issued_at: new Date().toISOString(),
    },
    // ⚠️ Trust on first use over plain HTTP (X4). The documented upgrade is
    // the installer's `--pin-key sha256:…`, compared before anything is written.
    policy_signing_keys: signingKey ? [signingKey.publicJwk] : [],
  };
}

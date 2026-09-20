import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db/index.js";
import { apikeys, devices } from "../db/schema.js";
import { mintDeviceKey } from "../lib/device-keys.js";
import { log } from "../lib/logger.js";
import { ProblemError } from "../lib/problem.js";

/**
 * `POST /api/agent/v1/credential/rotate` — a device exchanges its credential
 * for a fresh one, with the old one still valid for 24 hours.
 *
 * ⚠️ **This endpoint is not in the design document.** §4.5 names `credential`
 * as one of four `desired[]` kinds and never specifies its `spec`; the
 * enrolment response carries a `rotate_after` that nothing acts on; and
 * milestone 03's exit criterion asks for "credential rotation with the 24 h
 * server-side overlap" against no mechanism at all. Defined here in phase 3
 * from what rotation actually needs, exactly as the enrolment request body
 * and the telemetry `data` shapes were.
 *
 * ## Why the overlap exists, and what it is NOT for
 *
 * It is not a grace period for a slow agent — a rotation is one request and
 * completes in milliseconds. It exists because the write is on the *device*
 * and the device can lose power. The dangerous window is between "the server
 * has issued a new token and invalidated the old one" and "the agent has that
 * new token durably on disk". If those are not atomic — and across a network
 * and a filesystem they cannot be — then a power cut inside that window
 * leaves a Mac with no working credential, which means a re-enrolment
 * performed by hand, on site, by someone holding a one-time code.
 *
 * Twenty-four hours is far more than the milliseconds it takes; the point is
 * that it comfortably outlasts a reboot, a sleep, and a night.
 *
 * ## ⚠️ Rotation is NOT a way to stop enforcement
 *
 * X1b. A device that fails to rotate keeps its old credential and keeps
 * enforcing. A device whose old credential finally expires gets a 401, which
 * maps to `halt_sync_keep_enforcing` — it stops *syncing*. Nothing in this
 * file can reach the enforcer, and the cached policy is never invalidated by
 * anything that happens here (X1c).
 */
export async function handleCredentialRotate(c: Context): Promise<Response> {
  const deviceId = c.get("deviceId") as string;
  const householdId = c.get("householdId") as string;
  const user = c.get("user") as { id: string; isService?: boolean };

  // A.21 — device keys are owned by the household's `isService` user, never
  // by a human parent. A rotation that re-parented a key to whoever happened
  // to call would quietly make a device's credential deletable by removing a
  // person from the household.
  if (user.isService !== true) {
    throw new ProblemError("scopeViolation", "only a device credential may rotate itself");
  }

  const [device] = await db
    .select({
      id: devices.id,
      label: devices.label,
      apiKeyId: devices.apiKeyId,
      previousApiKeyId: devices.previousApiKeyId,
      previousExpiresAt: devices.previousApiKeyExpiresAt,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device?.apiKeyId) {
    throw new ProblemError("scopeViolation", "this device has no credential to rotate");
  }

  // ⚠️ Refuse a second rotation while the previous overlap is still open.
  //
  // Each rotation can only remember ONE predecessor, so rotating twice inside
  // 24 h would orphan the first old key — still enabled, still valid, and no
  // longer referenced by anything that would ever disable it. A credential
  // nothing will revoke is worse than no rotation at all.
  //
  // `backoff` rather than an error the agent treats as terminal: the desired
  // item is re-sent next tick and will succeed once the window closes.
  if (
    device.previousApiKeyId &&
    device.previousExpiresAt &&
    device.previousExpiresAt > new Date()
  ) {
    throw new ProblemError(
      "rotationInProgress",
      "a previous credential is still inside its 24h overlap",
      { action: "backoff" },
    );
  }

  const previousKeyId = device.apiKeyId;

  // ⚠️ Mint BEFORE touching the old key. If minting fails the device still
  // holds a working credential and simply tries again — the opposite order
  // would strand it.
  const minted = await mintDeviceKey({
    serviceUserId: user.id,
    deviceId: device.id,
    householdId,
    label: device.label ?? "device",
  });

  const expiresAt = new Date(Date.now() + OVERLAP_MS);

  await db.transaction(async (tx) => {
    // The old key stays ENABLED — that is the overlap. It simply gains an
    // expiry, which better-auth enforces itself, so the window closes even if
    // the nightly job never runs.
    await tx.update(apikeys).set({ expiresAt }).where(eq(apikeys.id, previousKeyId));

    await tx
      .update(devices)
      .set({
        apiKeyId: minted.keyId,
        previousApiKeyId: previousKeyId,
        previousApiKeyExpiresAt: expiresAt,
      })
      .where(eq(devices.id, device.id));
  });

  log.info(
    { event: "device.credential_rotated", device_id: device.id, key_id: minted.keyId },
    "rotated a device credential",
  );

  return c.json({
    credential: {
      token: minted.token,
      key_id: minted.keyId,
      issued_at: new Date().toISOString(),
      rotate_after: new Date(Date.now() + ROTATE_AFTER_MS).toISOString(),
    },
    previous_credential_valid_until: expiresAt.toISOString(),
  });
}

/** §4.5's "24 h server-side overlap". */
export const OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * How long a freshly issued credential is good for before the server starts
 * asking for a rotation. 90 days — long enough that rotation is routine
 * rather than constant, short enough that a leaked token has a horizon.
 */
export const ROTATE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Close every overlap window that has passed. Called by the nightly job.
 *
 * ⚠️ Belt and braces. `apikeys.expiresAt` already ends the window on its own,
 * inside better-auth. This disables the row as well and clears the pointer,
 * so an expired credential cannot be resurrected by someone clearing an
 * `expiresAt` they assumed was stale data.
 */
export async function closeExpiredRotations(now = new Date()): Promise<number> {
  const stale = await db
    .select({ id: devices.id, previousApiKeyId: devices.previousApiKeyId })
    .from(devices)
    .where(
      and(
        isNotNull(devices.previousApiKeyId),
        isNotNull(devices.previousApiKeyExpiresAt),
        lt(devices.previousApiKeyExpiresAt, now),
      ),
    );

  for (const row of stale) {
    if (!row.previousApiKeyId) continue;
    await db.update(apikeys).set({ enabled: false }).where(eq(apikeys.id, row.previousApiKeyId));
    await db
      .update(devices)
      .set({ previousApiKeyId: null, previousApiKeyExpiresAt: null })
      .where(eq(devices.id, row.id));
  }

  if (stale.length > 0) {
    log.info(
      { event: "device.rotation_overlap_closed", count: stale.length },
      "disabled superseded device credentials",
    );
  }
  return stale.length;
}

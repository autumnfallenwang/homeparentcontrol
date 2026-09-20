import { auth } from "../auth.js";

/**
 * What a device credential may do. Nothing else in the system mints keys, so
 * this is the complete authority any agent ever holds.
 *
 * ⚠️ `deviceResolver` in routes/agent.ts checks these per route. Stamping them
 * without checking them would be theatre.
 */
export const DEVICE_PERMISSIONS = {
  device: ["sync", "policy:read", "events:write"],
} as const;

/** One scope per agent endpoint. */
export type DevicePermission = (typeof DEVICE_PERMISSIONS)["device"][number];

export interface MintDeviceKeyInput {
  /** The household's `isService` user. NEVER a human parent — A.21. */
  serviceUserId: string;
  deviceId: string;
  householdId: string;
  /** Shown in the parent UI's credential list, e.g. "Lucy's Mac mini". */
  label: string;
}

export interface MintedDeviceKey {
  /** The bearer token. Returned to the agent ONCE and never retrievable again. */
  token: string;
  keyId: string;
}

/**
 * ★ X2, PLACE 2 OF 4 — the only place a device credential is ever minted.
 *
 * ⚠️ `apikeys.rateLimitEnabled` DEFAULTS TO TRUE in the schema (better-auth's
 * own shape). That default is the trap: any mint that omits the flag produces
 * an armed key that throttles at 10 requests per 24h. Measured: request 11
 * onward fails, and without `lib/auth-errors.ts` to classify it, it fails as
 * 401 Unauthorized. The agent maps 401 to `halt_sync_keep_enforcing`, so such
 * a device stops syncing about ten minutes after enrolment, claims its
 * credential was revoked, and goes on enforcing a policy it can never
 * update again.
 *
 * This function exists so there is exactly ONE call site to get right.
 * Do not call `auth.api.createApiKey` anywhere else.
 *
 * The plugin-level switch (place 1, `auth.ts`) should already make this
 * redundant. It is set anyway: two independent switches, plus a boot assertion
 * (place 3) that refuses to start if a row ever has it true, plus B2 (place 4).
 */
export async function mintDeviceKey(input: MintDeviceKeyInput): Promise<MintedDeviceKey> {
  const key = await auth.api.createApiKey({
    body: {
      name: input.label,
      prefix: "hpc_dk_",
      userId: input.serviceUserId,
      // ★ THE LINE. Do not remove, do not flip, do not "tidy up".
      rateLimitEnabled: false,
      metadata: {
        deviceId: input.deviceId,
        householdId: input.householdId,
      },
      // §5.9 — one scope per endpoint, so a leaked device key cannot do more
      // than a device needs to. ✅ B4 closed 2026-09-20: better-auth 1.4.19
      // accepts this exact shape, round-trips it through `verifyApiKey`, and
      // genuinely enforces it (a permission not granted returns valid:false).
      // Spread: the const assertion makes the array readonly, better-auth wants mutable.
      permissions: { device: [...DEVICE_PERMISSIONS.device] },
    },
  });

  return { token: key.key, keyId: key.id };
}

import { auth } from "../auth.js";

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
      // NOTE: no `permissions` yet — gate B4 (what shape better-auth 1.4.19
      // actually stores and enforces) is still open. Scoping a device key to
      // the agent endpoints is additive once B4 is settled.
    },
  });

  return { token: key.key, keyId: key.id };
}

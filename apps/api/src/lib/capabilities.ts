import { getSigningKey } from "../policy/signing.js";

/**
 * Capability negotiation (R4): "the server sends a device only what that device
 * advertised. Survives backports, partial rollouts and downgrades, and makes
 * the decision legible in a log line."
 *
 * ⚠️ R4 governs FEATURES, not work items. It decides what goes in
 * `server_capabilities` — it must NOT be used to filter `desired[]`, because an
 * item the device cannot do has to come back as `unsupported` and stop (R6).
 * Pre-filtering there would make `unsupported` unreachable and the mismatch
 * invisible. See `routes/sync.ts`.
 */

/**
 * What this server can actually do today.
 *
 * ⚠️ The spec never says where the server's own list comes from — §4.2 shows
 * five values in one example and stops. Keep this honest: a capability belongs
 * here only once the code behind it exists, because the agent uses the list to
 * decide what to expect.
 */
export function serverCapabilities(): string[] {
  return [
    "policy.v1",
    "policy.overrides",
    // Advertised only when a key is actually configured. Claiming this while
    // serving unsigned policy would tell the agent to expect a `jws` it will
    // never receive, and `policy_unsigned` has no health consequence to catch
    // the discrepancy.
    ...(getSigningKey() ? ["policy.signature.ed25519"] : []),
    "desired.agent_version",
    // ⚠️ NOT advertised yet: telemetry.session, telemetry.app_usage,
    // desired.credential, desired.diagnostics, desired.self_test. `/events`
    // is step 4c and the rest are phase 3. Add them when they are real.
  ];
}

/**
 * R4 applied: the intersection of what this server offers and what the device
 * said it understands. Order follows the server's list so the value is stable
 * for a given pair, which keeps log lines diffable.
 */
export function negotiate(advertised: readonly string[]): string[] {
  const claimed = new Set(advertised);
  return serverCapabilities().filter((capability) => claimed.has(capability));
}

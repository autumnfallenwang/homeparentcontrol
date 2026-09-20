/** Centralized env access. Nothing outside this module reads process.env. */
export const config = {
  databaseUrl: process.env.DATABASE_URL,
  apiPort: Number(process.env.API_PORT ?? 3001),
  logLevel: process.env.LOG_LEVEL ?? "info",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  tz: process.env.TZ ?? "America/New_York",

  /**
   * Set ONLY in the cluster (the chart sets `.arch.internal`). The UI and the
   * API are two different ingress hosts, so the session cookie has to be
   * domain-scoped to travel between them.
   *
   * ⚠️ Must stay UNSET in local dev. A `Domain=.arch.internal` cookie is
   * invalid for `localhost` and the browser drops it silently, which presents
   * as "sign-in returns 200, then every protected request 401s".
   *
   * These are subdomains of one registrable domain, so they are same-SITE:
   * SameSite=Lax is correct and no Secure/TLS is required. X4 is not in the way.
   */
  cookieDomain: process.env.COOKIE_DOMAIN?.trim() || undefined,

  /** Requests per minute per caller on /api/*. See middleware/rate-limit.ts. */
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 600),

  /**
   * The Ed25519 policy signing key, PKCS#8 PEM (A.16). Generate with
   * `openssl genpkey -algorithm ed25519`. In the cluster it is the
   * `POLICY_SIGNING_KEY` entry of `homeparentcontrol-secrets`.
   *
   * Literal `\n` sequences are accepted, because a multi-line PEM in an env
   * var is awkward in both a shell and a Helm values file.
   */
  policySigningKey: process.env.POLICY_SIGNING_KEY?.trim()
    ? process.env.POLICY_SIGNING_KEY.replace(/\\n/g, "\n")
    : undefined,

  /** Explicit opt-in to serving unsigned policy. See assertSigningConfigured. */
  allowUnsignedPolicy: process.env.ALLOW_UNSIGNED_POLICY === "1",

  /**
   * Retention ladder (§5.7). Raw samples are the bulk; everything projected
   * from them outlives them, so a pruned window is still visibly pruned in
   * reports rather than silently absent.
   */
  rawSampleRetentionDays: Number(process.env.RAW_SAMPLE_RETENTION_DAYS ?? 90),
  rawAuditRetentionDays: Number(process.env.RAW_AUDIT_RETENTION_DAYS ?? 400),
  usageHourlyRetentionDays: Number(process.env.USAGE_HOURLY_RETENTION_DAYS ?? 400),
  agentStatusRetentionDays: Number(process.env.AGENT_STATUS_RETENTION_DAYS ?? 400),

  /**
   * The longest an agent may hold undelivered events before evicting them
   * (`telemetry.max_queue_age_days` in the policy document). Mirrored here
   * because the boot assertion below needs it before any policy exists.
   */
  agentMaxQueueAgeDays: Number(process.env.AGENT_MAX_QUEUE_AGE_DAYS ?? 14),
} as const;

export type Config = typeof config;

/**
 * ⚠️ Refuse to start unsigned unless somebody said so out loud.
 *
 * The spec has no signing on/off switch — "disabled" is simply the absence of
 * a key — and `policy_unsigned` appears in no degraded list, no tripwire list
 * and no alert rule. So a control plane that quietly stopped signing would be
 * indistinguishable, to the parent, from one that signs: the agent would log a
 * line nobody reads and keep enforcing an unauthenticated policy.
 *
 * Making the dangerous configuration unreachable by accident is cheaper than
 * detecting it later, and matches how X2 and the retention ladder are handled.
 * Local dev sets ALLOW_UNSIGNED_POLICY=1 deliberately.
 */
export function assertSigningConfigured(
  c: Pick<Config, "policySigningKey" | "allowUnsignedPolicy">,
): void {
  if (!c.policySigningKey && !c.allowUnsignedPolicy) {
    throw new Error(
      "POLICY_SIGNING_KEY is not set. Policy would be served unsigned, which the agent " +
        "logs once and otherwise ignores — there is no health state for it. Set the key " +
        "(openssl genpkey -algorithm ed25519), or set ALLOW_UNSIGNED_POLICY=1 to say so " +
        "deliberately.",
    );
  }
}

/**
 * ⚠️ Hard invariant (§5.7) — refuse to start if violated.
 *
 * Raw sample retention MUST exceed the agent's maximum queue age. Otherwise a
 * long outage delivers events that are ingested and then pruned *before* the
 * projector ever touches them: data that arrived, was stored, and evaporated,
 * with no error anywhere. 90 vs 14 gives a bit over 6x headroom.
 *
 * Exported separately from the boot path so it is testable without a process exit.
 */
export function assertRetentionInvariant(
  c: Pick<Config, "rawSampleRetentionDays" | "agentMaxQueueAgeDays">,
): void {
  if (!(c.rawSampleRetentionDays > c.agentMaxQueueAgeDays)) {
    throw new Error(
      `retention invariant violated: RAW_SAMPLE_RETENTION_DAYS (${c.rawSampleRetentionDays}) ` +
        `must exceed AGENT_MAX_QUEUE_AGE_DAYS (${c.agentMaxQueueAgeDays}). ` +
        "Raw events would be pruned before the projector reads them, losing data silently.",
    );
  }
}

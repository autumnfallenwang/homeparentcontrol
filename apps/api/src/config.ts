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

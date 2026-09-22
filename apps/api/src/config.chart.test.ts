import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ★ Every setting the API reads must be supplied by the chart, or arrive as
 * a secret — and anything else must be a deliberate, named exception.
 *
 * ⚠️ This exists because of a real failure, not a hypothetical one. The chart
 * shipped without `COOKIE_DOMAIN`. Nothing broke: the app deployed, pods went
 * Healthy, both ingress hosts answered, the whole end-to-end agent suite
 * passed. Then the first human tried to log in — sign-in returned 200, a
 * session row was written, and every protected request 401'd, because the
 * cookie was host-only to the API while the browser was on the UI's host.
 *
 * `auth.ts` had a comment predicting that exact symptom. The code knew; the
 * chart did not; and no test connected them. This is that connection.
 */
const here = dirname(fileURLToPath(import.meta.url));
const chart = readFileSync(join(here, "../../../deploy/chart/values.yaml"), "utf8");
const configSource = readFileSync(join(here, "config.ts"), "utf8");

/** `api.env` keys in values.yaml — a flat block, so a line scan is honest. */
function chartEnvKeys(): Set<string> {
  const keys = new Set<string>();
  const start = chart.indexOf("\n  env:");
  const rest = chart.slice(start + 1);
  for (const line of rest.split("\n").slice(1)) {
    // Stop at the next key that is less indented than the env block's entries.
    if (/^\s{0,3}\S/.test(line)) break;
    const match = /^\s{4}([A-Z][A-Z0-9_]*):/.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

/** Everything `config.ts` reads out of the environment. */
function configEnvKeys(): Set<string> {
  return new Set(
    [...configSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1] as string),
  );
}

/**
 * Settings that legitimately do NOT appear in `api.env`, each with the
 * reason. ⚠️ Adding to this list is the way to make this test pass, so the
 * reason has to be real.
 */
const EXEMPT: Record<string, string> = {
  // Wired via secretKeyRef in deployment-api.yaml, never plaintext.
  DATABASE_URL: "secret",
  BETTER_AUTH_SECRET: "secret",
  POLICY_SIGNING_KEY: "secret",
  // Set from the ingress host in the Deployment template, not values.yaml.
  BETTER_AUTH_URL: "derived in deployment-api.yaml",
  // ⚠️ An explicit opt-in to serving UNSIGNED policy. Setting it in the
  // chart would be the opposite of deliberate.
  ALLOW_UNSIGNED_POLICY: "must never be set in the chart",
  // Has a safe default and no reason to differ per environment.
  RATE_LIMIT_PER_MIN: "defaulted",
};

describe("the chart supplies what the code reads", () => {
  it("the scan works — otherwise every assertion below is vacuous", () => {
    expect(chartEnvKeys().size).toBeGreaterThan(5);
    expect(configEnvKeys().size).toBeGreaterThan(5);
    expect(chartEnvKeys().has("API_PORT")).toBe(true);
  });

  it("★ every setting config.ts reads is in the chart, a secret, or exempted", () => {
    const missing = [...configEnvKeys()].filter(
      (key) => !chartEnvKeys().has(key) && !(key in EXEMPT),
    );
    expect(
      missing,
      `not supplied by deploy/chart/values.yaml and not exempted — see EXEMPT above`,
    ).toEqual([]);
  });

  // ★ The one that actually failed. Named explicitly, because the general
  // rule above could be satisfied by adding it to EXEMPT.
  it("★ COOKIE_DOMAIN is set — the UI and API are two hosts", () => {
    expect(chart).toMatch(/COOKIE_DOMAIN:\s*\.arch\.internal/);
    expect(EXEMPT.COOKIE_DOMAIN).toBeUndefined();
  });

  it("★ the secrets really are wired by secretKeyRef, not left out", () => {
    const deployment = readFileSync(
      join(here, "../../../deploy/chart/templates/deployment-api.yaml"),
      "utf8",
    );
    for (const key of ["DATABASE_URL", "BETTER_AUTH_SECRET", "POLICY_SIGNING_KEY"]) {
      expect(deployment, `${key} is exempted as a secret but not wired`).toContain(`key: ${key}`);
    }
  });

  // §5.7's invariant, as shipped rather than as intended.
  it("★ the chart's retention values satisfy the boot assertion", () => {
    const value = (k: string) => Number(new RegExp(`${k}: "(\\d+)"`).exec(chart)?.[1] ?? "0");
    expect(value("RAW_SAMPLE_RETENTION_DAYS")).toBeGreaterThan(value("AGENT_MAX_QUEUE_AGE_DAYS"));
  });
});

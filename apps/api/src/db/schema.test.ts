import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

/**
 * ⚠️ `casing: "snake_case"` is applied by the drizzle *client*, so `pgTable`'s
 * declared name is snake_case (it is written literally) while `column.name`
 * stays **camelCase** and is converted only when DDL or SQL is emitted.
 * Physical column names are asserted in schema.integration.test.ts, against a
 * real database, which is the only place they actually exist.
 */
const TABLES = Object.entries(schema).flatMap(([exportName, value]) => {
  try {
    return [[exportName, getTableConfig(value as never)] as const];
  } catch {
    return [];
  }
});
const byPhysicalName = new Map(TABLES.map(([, cfg]) => [cfg.name, cfg]));

const RULES = [
  "households",
  "household_members",
  "children",
  "devices",
  "policy_sets",
  "schedule_windows",
  "schedule_warnings",
  "schedule_budgets",
  "expected_online_windows",
  "calendar_exceptions",
  "overrides",
  "policy_versions",
  "desired_items",
  "enrollments",
];
const TELEMETRY = [
  "events",
  "projection_state",
  "usage_hourly",
  "usage_daily",
  "session_spans",
  "enforcement_log",
  "agent_status_intervals",
  "tripwires",
  "notifications",
  "digests",
];
const AUTH = ["users", "sessions", "accounts", "verifications", "apikeys"];

describe("schema completeness", () => {
  it.each(RULES)("defines rules-half table %s", (n) => expect(byPhysicalName.has(n)).toBe(true));
  it.each(TELEMETRY)("defines telemetry-half table %s", (n) =>
    expect(byPhysicalName.has(n)).toBe(true),
  );
  it.each(AUTH)("defines better-auth table %s", (n) => expect(byPhysicalName.has(n)).toBe(true));

  it("defines exactly 29 tables and no strays", () => {
    expect([...byPhysicalName.keys()].sort()).toEqual([...RULES, ...TELEMETRY, ...AUTH].sort());
  });

  it("declares every table name in snake_case", () => {
    expect([...byPhysicalName.keys()].filter((n) => /[A-Z]/.test(n))).toEqual([]);
  });
});

describe("safety-encoding columns", () => {
  /** Columns are keyed by their camelCase TS name — see the note above. */
  const col = (table: string, tsName: string) =>
    byPhysicalName.get(table)?.columns.find((c) => c.name === tsName);

  it("overrides.expiresAt is NOT NULL — a permanent relaxation is unrepresentable", () => {
    const c = col("overrides", "expiresAt");
    expect(c, "overrides.expiresAt must exist").toBeDefined();
    expect(c?.notNull, "Invariant E depends on this").toBe(true);
  });

  it("policy_sets has no failMode column — X11 removed it", () => {
    expect(col("policy_sets", "failMode")).toBeUndefined();
  });

  it("denormalises householdId onto the telemetry tables as the tenancy key", () => {
    for (const t of ["events", "usage_hourly", "usage_daily", "enforcement_log"]) {
      expect(col(t, "householdId"), `${t}.householdId`).toBeDefined();
    }
  });

  it("events has no primary key — unique(deviceId, eventId) IS the key", () => {
    expect(byPhysicalName.get("events")?.columns.filter((c) => c.primary)).toEqual([]);
  });

  it("keeps schedule_windows.action constrained by a CHECK — A.34", () => {
    const checks = byPhysicalName.get("schedule_windows")?.checks ?? [];
    expect(checks.map((c) => c.name)).toContain("schedule_windows_action_check");
  });
});

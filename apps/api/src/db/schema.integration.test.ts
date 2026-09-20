import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, db } from "./index.js";

/**
 * Proves the CHECK constraints actually reject at the database, not just in
 * Zod. These are the rules that survive a bug in the process — A.34's point:
 * the column that can power off a child's computer should not have its domain
 * defined only inside the process that might have the bug.
 *
 * Self-skips without DATABASE_URL so `test:fast` and CI stay DB-free.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

afterAll(async () => {
  if (hasDb) await closeDb();
});

d("CHECK constraints reject bad data", () => {
  it("schedule_windows rejects shutdown_grace_s = 0 — X12", async () => {
    // 0 silently reconstitutes bare shutdown, deleting the lock -> grace ->
    // shutdown ladder without anyone editing the action.
    const c = await db.execute(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'schedule_windows_grace_check'`);
    expect(c[0]?.def, "the grace CHECK must exist").toBeDefined();
    expect(String(c[0]?.def)).toMatch(/60/);
    expect(String(c[0]?.def)).not.toMatch(/>= 0\b/);
  });

  it("overrides.expires_at is NOT NULL at the database", async () => {
    const c = await db.execute(sql`
      select is_nullable from information_schema.columns
      where table_name = 'overrides' and column_name = 'expires_at'`);
    expect(c[0]?.is_nullable).toBe("NO");
  });

  it("overrides rejects granted_via = 'offline_code' — D.5", async () => {
    const c = await db.execute(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'overrides_granted_via_check'`);
    expect(String(c[0]?.def)).not.toMatch(/offline_code/);
  });

  it("desired_items rejects kind = 'override_key' — D.5, no side-door command channel", async () => {
    const c = await db.execute(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'desired_items_kind_check'`);
    expect(String(c[0]?.def)).not.toMatch(/override_key/);
    expect(String(c[0]?.def)).toMatch(/agent_version/);
  });

  it("schedule_windows.action is constrained at the database — A.34", async () => {
    const c = await db.execute(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'schedule_windows_action_check'`);
    expect(String(c[0]?.def)).toMatch(/warn_only/);
    expect(String(c[0]?.def)).toMatch(/shutdown/);
  });
});

d("foreign key posture", () => {
  it("households.service_user_id is RESTRICT, not CASCADE — A.21", async () => {
    // apikeys.user_id is NOT NULL ON DELETE CASCADE, so if device keys hung off
    // a human parent, deleting that parent would silently revoke every Mac.
    const c = await db.execute(sql`
      select rc.delete_rule from information_schema.referential_constraints rc
      join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name
      where k.table_name = 'households' and k.column_name = 'service_user_id'`);
    expect(c[0]?.delete_rule).toBe("RESTRICT");
  });

  it("households.service_user_id is nullable — the two-step insert needs it", async () => {
    const c = await db.execute(sql`
      select is_nullable from information_schema.columns
      where table_name = 'households' and column_name = 'service_user_id'`);
    expect(c[0]?.is_nullable).toBe("YES");
  });
});

d("migration applied cleanly", () => {
  it("created all 29 tables", async () => {
    const rows = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`);
    const names = rows.map((r) => String(r.table_name)).filter((n) => n !== "__drizzle_migrations");
    expect(names.length).toBe(29);
  });

  it("wrote snake_case columns everywhere — B1", async () => {
    const rows = await db.execute(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and column_name ~ '[A-Z]'`);
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
  });
});

// homeparentcontrol — Postgres schema (docs/design-decisions.md §5.1–§5.3).
//
// 29 tables: 5 better-auth core (copied verbatim from homecal), 14 rules half (§5.2),
// 10 telemetry half (§5.3). House conventions: uuid().primaryKey().defaultRandom(),
// timestamp({ withTimezone: true }), snake_case plural table names, the drizzle-0.45
// array form for table extras, onDelete: "cascade" as the default posture.
//
// `casing: "snake_case"` is set in drizzle.config.ts AND src/db/index.ts, so the TS field
// names stay camelCase and Drizzle derives every column name. Changing one without the
// other throws duplicate-key errors on upsert.

import { relations, type SQL, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════════════════════════════════════════════
// better-auth core — copied from homecal verbatim (§5.2). Two facts matter here and are
// handled in §5.4:
//   users.isService            — exists already in homecal
//   apikeys.userId             — NOT NULL ON DELETE CASCADE   ✅ verified in their schema
//   apikeys.rateLimitEnabled   — defaults to TRUE per row     ✅ verified in their schema
// ═══════════════════════════════════════════════════════════════════════════════════════

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  role: text().notNull().default("user"),
  banned: boolean().default(false),
  banReason: text(),
  banExpires: timestamp({ withTimezone: true }),
  // A.21 — TRUE for the one-per-household machine identity that owns every
  // device API key. Never signs in: no password, no `accounts` row, no session.
  // It exists so `apikeys.userId` has an owner that outlives any human parent,
  // because that column is NOT NULL ON DELETE CASCADE.
  isService: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  ipAddress: text(),
  userAgent: text(),
  impersonatedBy: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text().notNull(),
  providerId: text().notNull(),
  accessToken: text(),
  refreshToken: text(),
  accessTokenExpiresAt: timestamp({ withTimezone: true }),
  refreshTokenExpiresAt: timestamp({ withTimezone: true }),
  scope: text(),
  idToken: text(),
  password: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: uuid().primaryKey().defaultRandom(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// Better Auth apiKey plugin table. With `usePlural: true` in our adapter
// config, BA looks for `schema.apikeys` (plural). Both the Drizzle export
// and the SQL table name use the plural form.
export const apikeys = pgTable("apikeys", {
  id: uuid().primaryKey().defaultRandom(),
  name: text(),
  start: text(),
  prefix: text(),
  key: text().notNull(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  refillInterval: integer(),
  refillAmount: integer(),
  lastRefillAt: timestamp({ withTimezone: true }),
  enabled: boolean().notNull().default(true),
  rateLimitEnabled: boolean().notNull().default(true),
  rateLimitTimeWindow: integer(),
  rateLimitMax: integer(),
  requestCount: integer().notNull().default(0),
  remaining: integer(),
  lastRequest: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }),
  permissions: text(),
  metadata: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// §5.2 — rules half
// ═══════════════════════════════════════════════════════════════════════════════════════

export const households = pgTable("households", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  timezone: text().notNull().default("America/New_York"), // IANA, never an offset (A.30)
  holidayCountries: text().array(),
  holidaysEnabled: boolean().notNull().default(true),
  // A.21 — device keys MUST hang off this user, not off a human parent. apikeys.userId is
  // NOT NULL ON DELETE CASCADE, so deleting a parent would otherwise silently revoke every Mac.
  // Nullable only because nothing forces otherwise — `users` has no FK back to `households`, so
  // the first-run claim generates both UUIDs client-side and inserts the service user FIRST, with
  // no UPDATE and no window in which this is null. A half-built household is still representable;
  // `claimFirstHousehold()` is the only writer and it is transactional.
  serviceUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const householdMembers = pgTable(
  "household_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text().notNull().default("parent"), // owner | parent — Zod-enforced
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("household_members_household_id_idx").on(t.householdId),
    unique("household_members_household_user_unique").on(t.householdId, t.userId),
  ],
);

// A.18 — a DOMAIN row, never an auth subject. No users row, no session, no credential.
export const children = pgTable(
  "children",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    displayName: text().notNull(),
    timezone: text(), // NULL = inherit household
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("children_household_id_idx").on(t.householdId)],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    childId: uuid()
      .notNull()
      .references(() => children.id, { onDelete: "restrict" }),
    policySetId: uuid().references(() => policySets.id, { onDelete: "restrict" }),
    label: text().notNull(), // "Lucy's Mac mini"

    hardwareUuid: text(), // survives an OS reinstall (§5.6)
    hostname: text(),
    model: text(),

    // Administrative lifecycle. ORTHOGONAL to health state: a revoked device is still alive and
    // still enforcing.  pending | enrolled | active | revoked | decommissioned
    status: text().notNull().default("pending"),
    apiKeyId: uuid().references(() => apikeys.id, { onDelete: "set null" }),

    // Denormalised current state, written by the sync handler every tick, so "Today" is one read.
    lastSyncAt: timestamp({ withTimezone: true }),
    lastTickSeq: integer(),
    lastBootId: text(),
    systemBootTime: timestamp({ withTimezone: true }), // gap attribution, §7.4
    agentVersion: text(),
    osVersion: text(),
    arch: text(),
    appliedPolicyVersion: integer(),
    // ⚠️ Written by the SYNC handler, read by the liveness job. §7.3's DEGRADED
    //    condition is "ticking normally, but self-reporting <one of eight reasons>" —
    //    and those reasons are only visible in a sync body, which the liveness job
    //    (a timer, reading the database) never sees. Without this column DEGRADED is
    //    uncomputable. The spec never notices; it assumes one component does both.
    selfReportedReason: text(),
    // Owned by the liveness job alone (§7.3). The sync handler must not write these:
    // §5.2 says it does and §7.3 says a once-a-minute evaluation does, which would be
    // two writers on two cadences. One writer per column.
    healthState: text().notNull().default("UNENROLLED"),
    healthReason: text(),
    healthSince: timestamp({ withTimezone: true }),

    // A.19 / X6 — forces EXPECTED_OFFLINE so a school holiday cannot make SILENT_TOO_LONG fire
    // benignly and get the channel muted. NOT an override: an away device must still enforce
    // bedtime the moment it is switched on.
    awayUntil: timestamp({ withTimezone: true }),
    // Server-side sticky flag behind the 5 s `attended` cadence. Set by opening the device page.
    attendedUntil: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("devices_household_id_idx").on(t.householdId),
    index("devices_child_id_idx").on(t.childId),
    // Not globally unique — a decommissioned device keeps its hardwareUuid so a replacement can be
    // recognised. Uniqueness is enforced in the enrol handler against the live statuses.
    index("devices_hardware_uuid_idx").on(t.hardwareUuid),
  ],
);

export const policySets = pgTable(
  "policy_sets",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    childId: uuid()
      .notNull()
      .references(() => children.id, { onDelete: "cascade" }),
    name: text().notNull().default("Default"),
    kind: text().notNull().default("windows"), // D.4 discriminator

    // ★ X11 — there is deliberately NO `failMode` column here. §5.2 defined
    //   `failMode: text().notNull().default("open")` (O.1); the later ruling REMOVED it.
    //   The field lived inside the signed policy document, so in exactly the two classes where
    //   fail-open applies — no policy, corrupt policy — it cannot be read. Fail behaviour is a
    //   compiled-in invariant, not configuration. Do not "restore" this column.
    agentLogLevel: text().notNull().default("info"),
    diagnosticsRetentionDays: integer().notNull().default(7),

    pollBaseIntervalS: integer().notNull().default(60),
    pollBoundaryIntervalS: integer().notNull().default(15),
    pollBoundaryLeadS: integer().notNull().default(900),

    // D.5 — ONLINE GRANTS ONLY. There is deliberately no offlineCodes* column, no digit count,
    // no day window, no seq cap, no attempt throttle. If the HOTP card is ever revived, those
    // arrive as an additive migration alongside the tables it needs.
    overrideEnabled: boolean().notNull().default(true),
    overrideAllowedMinutes: smallint().array().notNull().default([15, 30, 60]),
    overrideMaxMinutesPerDay: integer().notNull().default(120),
    overrideMaxGrantsPerDay: integer().notNull().default(3),

    telemetryEnabled: boolean().notNull().default(true),
    telemetrySampleIntervalS: integer().notNull().default(60),
    telemetryFlushIntervalS: integer().notNull().default(300),
    telemetryCollect: text()
      .array()
      .notNull()
      .default(["session.state", "enforcement.*", "power.*", "app.usage_sample"]),
    telemetryMaxQueueEvents: integer().notNull().default(50000),
    telemetryMaxQueueBytes: integer().notNull().default(33554432),
    telemetryMaxQueueAgeDays: integer().notNull().default(14),
    telemetryAuditRetentionDays: integer().notNull().default(90),

    // X1c — warn only. There is NO stalenessMaxAgeS, because a TTL that relaxes enforcement is a
    // remotely-triggerable bypass and there is nothing for such a column to do.
    stalenessWarnAfterS: integer().notNull().default(86400),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("policy_sets_child_id_idx").on(t.childId),
    check(
      "policy_sets_override_caps_check",
      sql`
    ${t.overrideMaxMinutesPerDay} BETWEEN 0 AND 480
    AND ${t.overrideMaxGrantsPerDay} BETWEEN 0 AND 10`,
    ),
  ],
);

export const scheduleWindows = pgTable(
  "schedule_windows",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    policySetId: uuid()
      .notNull()
      .references(() => policySets.id, { onDelete: "cascade" }),
    label: text().notNull(),
    days: text().array().notNull(), // ["sun","mon",…] — wire-identical
    restrictedFrom: time().notNull(),
    restrictedUntil: time().notNull(),
    // Derived ONCE so the UI, the compiler and the validator cannot each re-derive the wrap rule
    // slightly differently. Three re-derivations is how an off-by-one-night bug ships.
    //
    // ⚠️ The callback references `scheduleWindows` — the table const being defined — NOT `t`.
    //    It works only because the callback is lazy and the return type is annotated. Do not
    //    "fix" it to `t.`, and do not evaluate it eagerly.
    crossesMidnight: boolean().generatedAlwaysAs(
      (): SQL => sql`${scheduleWindows.restrictedUntil} <= ${scheduleWindows.restrictedFrom}`,
    ),

    // ★ THE ONE DEVIATION from the house's no-DB-enums convention (A.34). This is the column that
    //   can power off a child's computer; its domain does not belong in a Zod schema living inside
    //   the process that might have the bug. A CHECK is the minimum-blast-radius form.
    action: text().notNull().default("lock"),
    shutdownGraceS: integer().notNull().default(300), // D.3
    escalateAfterFailures: smallint().notNull().default(3),

    sortOrder: smallint().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("schedule_windows_policy_set_id_idx").on(t.policySetId),
    check("schedule_windows_action_check", sql`${t.action} IN ('warn_only', 'lock', 'shutdown')`),
    check(
      "schedule_windows_days_check",
      sql`${t.days} <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[]
        AND array_length(${t.days}, 1) >= 1`,
    ),
    check(
      "schedule_windows_distinct_bounds_check",
      sql`${t.restrictedFrom} <> ${t.restrictedUntil}`,
    ),
    // ★ X12 SUPERSEDES §5.2's lower bound of 0. Zero silently reconstitutes bare shutdown,
    //   deleting the lock → grace → shutdown ladder without anyone editing the action. The grace
    //   period is what makes the ladder different from the thing it replaced.
    check("schedule_windows_grace_check", sql`${t.shutdownGraceS} BETWEEN 60 AND 3600`),
  ],
);

export const scheduleWarnings = pgTable(
  "schedule_warnings",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    windowId: uuid()
      .notNull()
      .references(() => scheduleWindows.id, { onDelete: "cascade" }),
    leadMinutes: smallint().notNull(),
    channel: text().notNull().default("modal"), // banner | modal  (§3.3)
  },
  (t) => [
    index("schedule_warnings_window_id_idx").on(t.windowId),
    unique("schedule_warnings_window_lead_unique").on(t.windowId, t.leadMinutes),
    check("schedule_warnings_lead_check", sql`${t.leadMinutes} BETWEEN 1 AND 240`),
  ],
);

// D.4's seat. Ships EMPTY. `meter` defaults to active_s (A.33) — recorded in the schema so it
// cannot be forgotten when someone finally builds budgets.
export const scheduleBudgets = pgTable(
  "schedule_budgets",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    policySetId: uuid()
      .notNull()
      .references(() => policySets.id, { onDelete: "cascade" }),
    days: text().array().notNull(),
    budgetMinutes: integer().notNull(),
    meter: text().notNull().default("active_s"),
    resetAt: time().notNull().default("04:00"),
    action: text().notNull().default("lock"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("schedule_budgets_policy_set_id_idx").on(t.policySetId),
    check("schedule_budgets_action_check", sql`${t.action} IN ('warn_only','lock','shutdown')`),
    check("schedule_budgets_meter_check", sql`${t.meter} IN ('active_s','foreground_s')`),
  ],
);

// Drives EXPECTED_OFFLINE, never enforcement.
export const expectedOnlineWindows = pgTable(
  "expected_online_windows",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    policySetId: uuid()
      .notNull()
      .references(() => policySets.id, { onDelete: "cascade" }),
    days: text().array().notNull(),
    fromTime: time().notNull(),
    untilTime: time().notNull(),
  },
  (t) => [index("expected_online_windows_policy_set_id_idx").on(t.policySetId)],
);

// Parent INTENT only. date-holidays is called LIVE at compile time; this table never mirrors it.
export const calendarExceptions = pgTable(
  "calendar_exceptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    childId: uuid().references(() => children.id, { onDelete: "cascade" }), // NULL = all children
    day: date().notNull(),
    effect: text().notNull(), // treat_as_weekend | no_bedtime | custom | dismiss_holiday
    extendMinutes: integer(),
    windowId: uuid().references(() => scheduleWindows.id, { onDelete: "cascade" }),
    note: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendar_exceptions_household_day_idx").on(t.householdId, t.day),
    unique("calendar_exceptions_child_day_window_unique").on(t.childId, t.day, t.windowId),
    check(
      "calendar_exceptions_effect_check",
      sql`${t.effect} IN
    ('treat_as_weekend','no_bedtime','custom','dismiss_holiday')`,
    ),
    check(
      "calendar_exceptions_minutes_check",
      sql`${t.effect} <> 'custom' OR ${t.extendMinutes} > 0`,
    ),
  ],
);

// ═══ EVERY relaxation in the system is a row here. ONE table, because D.5 removed the other two.
export const overrides = pgTable(
  "overrides",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    childId: uuid()
      .notNull()
      .references(() => children.id, { onDelete: "cascade" }),
    deviceId: uuid().references(() => devices.id, { onDelete: "cascade" }), // NULL = all devices
    type: text().notNull().default("extend"), // extend | suspend | grant_minutes
    windowId: uuid().references(() => scheduleWindows.id, { onDelete: "cascade" }),
    minutes: integer(),
    effectiveDate: date().notNull(),

    // ★ A.8 / the load-bearing constraint in this schema. There is no column in which to store
    //   "never expires", so no feature added later can create a permanent relaxation.
    expiresAt: timestamp({ withTimezone: true }).notNull(),

    // D.5 — 'ui' | 'calendar' ONLY. 'offline_code' is not a value, because offline codes do not
    // exist. If they are ever revived, redemptions get their OWN table and are NEVER compiled
    // back into policy.overrides[] (a spent grant that re-arms itself is maddening to reproduce).
    grantedVia: text().notNull().default("ui"),
    grantedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    sourceExceptionId: uuid().references(() => calendarExceptions.id, { onDelete: "cascade" }),
    reason: text(),

    revokedAt: timestamp({ withTimezone: true }),
    revokedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("overrides_child_effective_date_idx").on(t.childId, t.effectiveDate),
    index("overrides_expires_at_idx").on(t.expiresAt),
    check("overrides_type_check", sql`${t.type} IN ('extend','suspend','grant_minutes')`),
    check("overrides_granted_via_check", sql`${t.grantedVia} IN ('ui','calendar')`),
    check("overrides_minutes_check", sql`${t.type} = 'suspend' OR ${t.minutes} > 0`),
  ],
);

// ═══ THE WIRE ARTEFACT — immutable, append-only, content-addressed.
export const policyVersions = pgTable(
  "policy_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    policySetId: uuid()
      .notNull()
      .references(() => policySets.id, { onDelete: "restrict" }),
    version: integer().notNull(), // monotonic PER DEVICE
    document: jsonb().notNull(), // the EXACT bytes that were signed
    documentHash: text().notNull(), // sha256(canonical JSON)
    jws: text(),
    signingKeyId: text(),
    // W/"pol-<hash12>-v<version>" — TWELVE hash characters. §4.2's example shows 8; this column
    // comment is the ruling and 12 is what packages/contract emits.
    etag: text().notNull(),
    issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    notBefore: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // A.20 / C3 — set TRUE only for a TIGHTENING that bites within 15 min. Relaxations exempt.
    confirmImmediateEffect: boolean().notNull().default(false),
    publishedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    publishReason: text(), // schedule_edit | override | calendar | restore
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("policy_versions_device_version_unique").on(t.deviceId, t.version),
    index("policy_versions_device_created_at_idx").on(t.deviceId, t.createdAt),
    index("policy_versions_etag_idx").on(t.etag),
  ],
);

// Per-device operational intent that must NOT be persisted into the policy cache.
// Re-sent EVERY tick until the server OBSERVES convergence.
export const desiredItems = pgTable(
  "desired_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    spec: jsonb().notNull(),
    status: text().notNull().default("pending"), // pending | converged | unsupported
    unsupportedDetail: text(),
    observedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("desired_items_device_status_idx").on(t.deviceId, t.status),
    // D.5 — 'override_key' is NOT a kind. No generic escape hatch: that would smuggle the deleted
    // command channel back in through the side door.
    check(
      "desired_items_kind_check",
      sql`${t.kind} IN ('credential','diagnostics','self_test','agent_version')`,
    ),
  ],
);

export const enrollments = pgTable(
  "enrollments",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    codeHash: text().notNull(), // sha256 of the normalised code
    codeHint: text().notNull(), // "HPC-K7QM" — which code is this
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    consumedAt: timestamp({ withTimezone: true }),
    consumedIp: text(),
    consumedHardwareUuid: text(),
    reissueCount: smallint().notNull().default(0),
    attempts: smallint().notNull().default(0),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("enrollments_code_hash_unique").on(t.codeHash),
    index("enrollments_device_id_idx").on(t.deviceId),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════
// §5.3 — telemetry half
// ═══════════════════════════════════════════════════════════════════════════════════════

// ═══ RAW LANDING ZONE — R8, "store first, interpret later".
export const events = pgTable(
  "events",
  {
    // No surrogate PK — (device_id, event_id) IS the key.
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    // A.12 / X5 — UUIDv7, canonical lowercase hyphenated. The ingest handler REJECTS anything
    // else with retryable:false; it does NOT normalise. One spelling, one format, loud in dev.
    eventId: uuid().notNull(),
    type: text().notNull(), // NEVER rejected when unknown (R8)
    v: smallint().notNull().default(1),
    class: text().notNull(), // 'sample' | 'audit'
    ts: timestamp({ withTimezone: true }).notNull(), // agent clock: ADVISORY
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(), // authoritative
    bootId: text().notNull(), // agent-generated, opaque → text
    seq: integer().notNull(), // (bootId, seq) is the true ordering
    data: jsonb().notNull(),
  },
  (t) => [
    unique("events_device_event_unique").on(t.deviceId, t.eventId), // idempotency — non-negotiable
    index("events_device_ts_idx").on(t.deviceId, t.ts), // projector + psql archaeology
    index("events_received_at_brin_idx").using("brin", t.receivedAt), // the retention prune
  ],
);

// Watermark per projection. Keyed on received_at (server clock), NEVER on ts — a child stepping
// the local clock backwards must not push her own events permanently behind the watermark.
export const projectionState = pgTable("projection_state", {
  name: text().primaryKey(), // usage_hourly | sessions | enforcement
  watermarkReceivedAt: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`'epoch'::timestamptz`),
  lastRunAt: timestamp({ withTimezone: true }),
  lastRunRows: integer().notNull().default(0),
  lastError: text(),
});

export const usageHourly = pgTable(
  "usage_hourly",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    childId: uuid()
      .notNull()
      .references(() => children.id, { onDelete: "cascade" }),
    bucketStart: timestamp({ withTimezone: true }).notNull(), // UTC hour boundary
    bundleId: text().notNull(), // "com.apple.Safari"
    foregroundS: integer().notNull().default(0),
    // ★ A.33 — the meter. Only one app is frontmost at a time, so per-app active_s are DISJOINT
    //   and SUM() over a day is correct, not an over-count. This looks wrong; do not "fix" it.
    activeS: integer().notNull().default(0),
    cpuPctAvg: integer().notNull().default(0), // ×100, basis points
    sampleCount: smallint().notNull().default(0),
    // D.1 — there are deliberately NO title/url columns. Adding them is additive (R2) AND requires
    // a TCC grant, which under ad-hoc signing dies on every rebuild (§3.6). Read that first.
    projectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("usage_hourly_device_bucket_bundle_unique").on(t.deviceId, t.bucketStart, t.bundleId),
    index("usage_hourly_child_bucket_idx").on(t.childId, t.bucketStart),
  ],
);

export const usageDaily = pgTable(
  "usage_daily",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    childId: uuid()
      .notNull()
      .references(() => children.id, { onDelete: "cascade" }),
    // ★ LOCAL day in policy.timezone, NOT date_trunc('day', ts) in UTC. Get this wrong and Sunday
    //   evening shows up on Monday — the first thing a parent notices, the last thing anyone checks.
    localDay: date().notNull(),
    bundleId: text().notNull(),
    foregroundS: integer().notNull().default(0),
    activeS: integer().notNull().default(0),
    projectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("usage_daily_device_day_bundle_unique").on(t.deviceId, t.localDay, t.bundleId),
    index("usage_daily_child_day_idx").on(t.childId, t.localDay),
  ],
);

export const sessionSpans = pgTable(
  "session_spans",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    childId: uuid()
      .notNull()
      .references(() => children.id, { onDelete: "cascade" }),
    kind: text().notNull(), // awake | active | locked | asleep
    startedAt: timestamp({ withTimezone: true }).notNull(),
    endedAt: timestamp({ withTimezone: true }), // NULL = still open
    bootId: text(),
    consoleUser: text(),
    // TRUE when the end was inferred from silence rather than observed. Renders as a dashed edge —
    // an honest "we don't actually know".
    endInferred: boolean().notNull().default(false),
  },
  (t) => [
    index("session_spans_device_started_at_idx").on(t.deviceId, t.startedAt),
    unique("session_spans_device_kind_started_unique").on(t.deviceId, t.kind, t.startedAt),
  ],
);

// THIS IS THE PRODUCT — what a parent means when they ask "but what actually happened?".
export const enforcementLog = pgTable(
  "enforcement_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    childId: uuid()
      .notNull()
      .references(() => children.id, { onDelete: "cascade" }),
    eventId: uuid().notNull(), // back-reference into events; survives its pruning
    // warning_shown | warning_failed | action_taken | action_failed | policy_applied |
    // policy_rejected | degraded | clock_stepped | override_granted | override_expired |
    // queue_evicted | kill_switch_present | agent_started | agent_stopping
    kind: text().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    windowId: uuid().references(() => scheduleWindows.id, { onDelete: "set null" }),
    policyVersion: integer(),
    // The one denormalised human-readable line the report renders. Composed at projection time so
    // a schema change to `detail` cannot break old history.
    summary: text().notNull(),
    detail: jsonb(),
    projectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("enforcement_log_event_id_unique").on(t.eventId),
    index("enforcement_log_child_occurred_at_idx").on(t.childId, t.occurredAt),
    index("enforcement_log_device_kind_idx").on(t.deviceId, t.kind),
  ],
);

// Five states stored as INTERVALS — ~8 rows/day, not 1,440. See §7.3.
export const agentStatusIntervals = pgTable(
  "agent_status_intervals",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    state: text().notNull(),
    reason: text(),
    enteredAt: timestamp({ withTimezone: true }).notNull(),
    exitedAt: timestamp({ withTimezone: true }),
    // Enter UNEXPECTED_SILENCE at 10 min, but do not notify until 60 — a macOS update restart
    // routinely exceeds 10 minutes on Apple silicon.
    notifiedAt: timestamp({ withTimezone: true }),
    // Retrospective reclassification: if system_boot_time lands inside the silence window, the Mac
    // was simply off, and the interval is rewritten to EXPECTED_OFFLINE after the fact. §7.4.
    reclassifiedFrom: text(),
  },
  (t) => [index("agent_status_intervals_device_entered_at_idx").on(t.deviceId, t.enteredAt)],
);

// Cheap non-boundary signals. Surfaced as ONE banner, never eight alerts, and under AR.1
// deliberately never as a notification: the value is that the history exists when someone later
// asks "has she ever tried?".
export const tripwires = pgTable(
  "tripwires",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    // hardware_uuid_mismatch | unexpected_source_ip | concurrent_boot_ids |
    // signature_invalid | policy_version_regression | network_time_disabled |
    // timezone_mismatch | agent_stopped_while_up | kill_switch_present
    kind: text().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    occurrences: integer().notNull().default(1),
    detail: jsonb(),
    acknowledgedAt: timestamp({ withTimezone: true }),
    acknowledgedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("tripwires_device_kind_unique").on(t.deviceId, t.kind),
    index("tripwires_household_last_seen_idx").on(t.householdId, t.lastSeenAt),
  ],
);

// D.2 support — one query service, four sinks, no commitment. Both tables are tiny and exist on
// day one so that "turn on the weekly email" is a config flag rather than a migration.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().references(() => devices.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    severity: text().notNull().default("info"), // info | warning | critical
    title: text().notNull(),
    body: text().notNull(),
    dedupeKey: text().notNull(),
    firstFiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastFiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp({ withTimezone: true }),
    deliveryChannel: text(), // ui | email | webhook | grafana
    readAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("notifications_household_dedupe_unique").on(t.householdId, t.dedupeKey),
    index("notifications_household_last_fired_idx").on(t.householdId, t.lastFiredAt),
  ],
);

export const digests = pgTable(
  "digests",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    childId: uuid().references(() => children.id, { onDelete: "cascade" }),
    period: text().notNull(), // daily | weekly | monthly
    periodStart: date().notNull(),
    periodEnd: date().notNull(),
    // The EXACT output of reportQuery(). Rendering a stored digest must NEVER re-run the query —
    // otherwise last week's email and last week's archived page disagree after a projector fix.
    payload: jsonb().notNull(),
    generatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp({ withTimezone: true }),
    deliveryChannel: text(),
  },
  (t) => [
    unique("digests_household_child_period_unique").on(
      t.householdId,
      t.childId,
      t.period,
      t.periodStart,
    ),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════
// Relations — §5.2 mandates "a trailing relations() block", imports `relations`, and then
// never writes one. Derived here from the actual foreign-key graph (§5.1's identity chain)
// so the two cannot drift.
//
// Two naming rules:
//   1. The six audit-author edges (createdBy / grantedBy / revokedBy / publishedBy /
//      acknowledgedBy — all ON DELETE SET NULL) get a `…ByUser` relation name, because a
//      relation sharing a name with a column of the same table collides in the relational
//      query builder's result shape.
//   2. `overrides` points at `users` twice, so both of those edges carry an explicit
//      `relationName`; drizzle cannot pair them otherwise.
// ═══════════════════════════════════════════════════════════════════════════════════════

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  apikeys: many(apikeys),
  householdMembers: many(householdMembers),
  // A.21 — the isService user every device api key in a household hangs off.
  serviceForHouseholds: many(households),
  calendarExceptions: many(calendarExceptions),
  overridesGranted: many(overrides, { relationName: "overrides_grantedBy" }),
  overridesRevoked: many(overrides, { relationName: "overrides_revokedBy" }),
  policyVersions: many(policyVersions),
  enrollments: many(enrollments),
  tripwires: many(tripwires),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const apikeysRelations = relations(apikeys, ({ one, many }) => ({
  user: one(users, { fields: [apikeys.userId], references: [users.id] }),
  devices: many(devices),
}));

export const householdsRelations = relations(households, ({ one, many }) => ({
  serviceUser: one(users, { fields: [households.serviceUserId], references: [users.id] }),
  householdMembers: many(householdMembers),
  children: many(children),
  devices: many(devices),
  policySets: many(policySets),
  scheduleWindows: many(scheduleWindows),
  scheduleWarnings: many(scheduleWarnings),
  scheduleBudgets: many(scheduleBudgets),
  expectedOnlineWindows: many(expectedOnlineWindows),
  calendarExceptions: many(calendarExceptions),
  overrides: many(overrides),
  policyVersions: many(policyVersions),
  desiredItems: many(desiredItems),
  enrollments: many(enrollments),
  events: many(events),
  usageHourly: many(usageHourly),
  usageDaily: many(usageDaily),
  sessionSpans: many(sessionSpans),
  enforcementLog: many(enforcementLog),
  agentStatusIntervals: many(agentStatusIntervals),
  tripwires: many(tripwires),
  notifications: many(notifications),
  digests: many(digests),
}));

export const householdMembersRelations = relations(householdMembers, ({ one }) => ({
  household: one(households, {
    fields: [householdMembers.householdId],
    references: [households.id],
  }),
  user: one(users, { fields: [householdMembers.userId], references: [users.id] }),
}));

export const childrenRelations = relations(children, ({ one, many }) => ({
  household: one(households, { fields: [children.householdId], references: [households.id] }),
  policySets: many(policySets),
  devices: many(devices),
  calendarExceptions: many(calendarExceptions),
  overrides: many(overrides),
  usageHourly: many(usageHourly),
  usageDaily: many(usageDaily),
  sessionSpans: many(sessionSpans),
  enforcementLog: many(enforcementLog),
  digests: many(digests),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  household: one(households, { fields: [devices.householdId], references: [households.id] }),
  child: one(children, { fields: [devices.childId], references: [children.id] }),
  policySet: one(policySets, { fields: [devices.policySetId], references: [policySets.id] }),
  apiKey: one(apikeys, { fields: [devices.apiKeyId], references: [apikeys.id] }),
  policyVersions: many(policyVersions),
  desiredItems: many(desiredItems),
  enrollments: many(enrollments),
  tripwires: many(tripwires),
  overrides: many(overrides),
  events: many(events),
  usageHourly: many(usageHourly),
  usageDaily: many(usageDaily),
  sessionSpans: many(sessionSpans),
  enforcementLog: many(enforcementLog),
  agentStatusIntervals: many(agentStatusIntervals),
  notifications: many(notifications),
}));

export const policySetsRelations = relations(policySets, ({ one, many }) => ({
  household: one(households, { fields: [policySets.householdId], references: [households.id] }),
  child: one(children, { fields: [policySets.childId], references: [children.id] }),
  devices: many(devices),
  scheduleWindows: many(scheduleWindows),
  scheduleBudgets: many(scheduleBudgets),
  expectedOnlineWindows: many(expectedOnlineWindows),
  policyVersions: many(policyVersions),
}));

export const scheduleWindowsRelations = relations(scheduleWindows, ({ one, many }) => ({
  household: one(households, {
    fields: [scheduleWindows.householdId],
    references: [households.id],
  }),
  policySet: one(policySets, {
    fields: [scheduleWindows.policySetId],
    references: [policySets.id],
  }),
  scheduleWarnings: many(scheduleWarnings),
  calendarExceptions: many(calendarExceptions),
  overrides: many(overrides),
  enforcementLog: many(enforcementLog),
}));

export const scheduleWarningsRelations = relations(scheduleWarnings, ({ one }) => ({
  household: one(households, {
    fields: [scheduleWarnings.householdId],
    references: [households.id],
  }),
  window: one(scheduleWindows, {
    fields: [scheduleWarnings.windowId],
    references: [scheduleWindows.id],
  }),
}));

export const scheduleBudgetsRelations = relations(scheduleBudgets, ({ one }) => ({
  household: one(households, {
    fields: [scheduleBudgets.householdId],
    references: [households.id],
  }),
  policySet: one(policySets, {
    fields: [scheduleBudgets.policySetId],
    references: [policySets.id],
  }),
}));

export const expectedOnlineWindowsRelations = relations(expectedOnlineWindows, ({ one }) => ({
  household: one(households, {
    fields: [expectedOnlineWindows.householdId],
    references: [households.id],
  }),
  policySet: one(policySets, {
    fields: [expectedOnlineWindows.policySetId],
    references: [policySets.id],
  }),
}));

export const calendarExceptionsRelations = relations(calendarExceptions, ({ one, many }) => ({
  household: one(households, {
    fields: [calendarExceptions.householdId],
    references: [households.id],
  }),
  child: one(children, { fields: [calendarExceptions.childId], references: [children.id] }),
  window: one(scheduleWindows, {
    fields: [calendarExceptions.windowId],
    references: [scheduleWindows.id],
  }),
  createdByUser: one(users, { fields: [calendarExceptions.createdBy], references: [users.id] }),
  overrides: many(overrides),
}));

export const overridesRelations = relations(overrides, ({ one }) => ({
  household: one(households, { fields: [overrides.householdId], references: [households.id] }),
  child: one(children, { fields: [overrides.childId], references: [children.id] }),
  device: one(devices, { fields: [overrides.deviceId], references: [devices.id] }),
  window: one(scheduleWindows, {
    fields: [overrides.windowId],
    references: [scheduleWindows.id],
  }),
  sourceException: one(calendarExceptions, {
    fields: [overrides.sourceExceptionId],
    references: [calendarExceptions.id],
  }),
  grantedByUser: one(users, {
    fields: [overrides.grantedBy],
    references: [users.id],
    relationName: "overrides_grantedBy",
  }),
  revokedByUser: one(users, {
    fields: [overrides.revokedBy],
    references: [users.id],
    relationName: "overrides_revokedBy",
  }),
}));

export const policyVersionsRelations = relations(policyVersions, ({ one }) => ({
  household: one(households, { fields: [policyVersions.householdId], references: [households.id] }),
  device: one(devices, { fields: [policyVersions.deviceId], references: [devices.id] }),
  policySet: one(policySets, {
    fields: [policyVersions.policySetId],
    references: [policySets.id],
  }),
  publishedByUser: one(users, { fields: [policyVersions.publishedBy], references: [users.id] }),
}));

export const desiredItemsRelations = relations(desiredItems, ({ one }) => ({
  household: one(households, { fields: [desiredItems.householdId], references: [households.id] }),
  device: one(devices, { fields: [desiredItems.deviceId], references: [devices.id] }),
}));

export const enrollmentsRelations = relations(enrollments, ({ one }) => ({
  household: one(households, { fields: [enrollments.householdId], references: [households.id] }),
  device: one(devices, { fields: [enrollments.deviceId], references: [devices.id] }),
  createdByUser: one(users, { fields: [enrollments.createdBy], references: [users.id] }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  household: one(households, { fields: [events.householdId], references: [households.id] }),
  device: one(devices, { fields: [events.deviceId], references: [devices.id] }),
}));

export const usageHourlyRelations = relations(usageHourly, ({ one }) => ({
  household: one(households, { fields: [usageHourly.householdId], references: [households.id] }),
  device: one(devices, { fields: [usageHourly.deviceId], references: [devices.id] }),
  child: one(children, { fields: [usageHourly.childId], references: [children.id] }),
}));

export const usageDailyRelations = relations(usageDaily, ({ one }) => ({
  household: one(households, { fields: [usageDaily.householdId], references: [households.id] }),
  device: one(devices, { fields: [usageDaily.deviceId], references: [devices.id] }),
  child: one(children, { fields: [usageDaily.childId], references: [children.id] }),
}));

export const sessionSpansRelations = relations(sessionSpans, ({ one }) => ({
  household: one(households, { fields: [sessionSpans.householdId], references: [households.id] }),
  device: one(devices, { fields: [sessionSpans.deviceId], references: [devices.id] }),
  child: one(children, { fields: [sessionSpans.childId], references: [children.id] }),
}));

export const enforcementLogRelations = relations(enforcementLog, ({ one }) => ({
  household: one(households, { fields: [enforcementLog.householdId], references: [households.id] }),
  device: one(devices, { fields: [enforcementLog.deviceId], references: [devices.id] }),
  child: one(children, { fields: [enforcementLog.childId], references: [children.id] }),
  window: one(scheduleWindows, {
    fields: [enforcementLog.windowId],
    references: [scheduleWindows.id],
  }),
}));

export const agentStatusIntervalsRelations = relations(agentStatusIntervals, ({ one }) => ({
  household: one(households, {
    fields: [agentStatusIntervals.householdId],
    references: [households.id],
  }),
  device: one(devices, { fields: [agentStatusIntervals.deviceId], references: [devices.id] }),
}));

export const tripwiresRelations = relations(tripwires, ({ one }) => ({
  household: one(households, { fields: [tripwires.householdId], references: [households.id] }),
  device: one(devices, { fields: [tripwires.deviceId], references: [devices.id] }),
  acknowledgedByUser: one(users, {
    fields: [tripwires.acknowledgedBy],
    references: [users.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  household: one(households, { fields: [notifications.householdId], references: [households.id] }),
  device: one(devices, { fields: [notifications.deviceId], references: [devices.id] }),
}));

export const digestsRelations = relations(digests, ({ one }) => ({
  household: one(households, { fields: [digests.householdId], references: [households.id] }),
  child: one(children, { fields: [digests.childId], references: [children.id] }),
}));

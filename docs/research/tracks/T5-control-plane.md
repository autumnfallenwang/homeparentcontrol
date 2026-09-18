# T5 — Control plane design

**Date:** 2026-09-18
**Track:** T5 of [`poc2-plan.md`](../poc2-plan.md). **Design work, not research.** POC 2 §3 explicitly
reclassified this track: *"T1 and T4 have now supplied everything T5 needed. What remains is design
work against the owner's own `home*` template, not investigation."*
**Inputs (read, not assumed):** [`requirements.md`](../../requirements.md) · [`poc2-findings.md`](../poc2-findings.md) ·
[`raw/T4-contract.md`](./T4-contract.md) (**fixed — designed to, not redesigned**) ·
[`raw/T8-parent-override.md`](./T8-parent-override.md) ·
[`raw/T1-telemetry-ceiling.md`](./T1-telemetry-ceiling.md) ·
[`raw/T6-observability.md`](./T6-observability.md) ·
[`raw/T3-lifecycle-operability.md`](./T3-lifecycle-operability.md) · the `autumnfallenwang/homecal`
source.

**Status:** design complete. Nothing here needs a lab. Items marked ⚠️ are conflicts or open
decisions, not unfinished work.

### How to read the provenance tags

| Tag | Meaning |
|---|---|
| **[T*n*]** | Read directly out of that track's document. Cited, not re-derived. |
| **[homecal]** | Read directly out of the `autumnfallenwang/homecal` source. |
| **[INFERENCE]** | My design decision. Defensible, but nobody else has said it. Argue with these. |
| **[ARITH]** | A calculation, with its assumptions stated inline so you can redo it. |

---

## 0. Verdicts first

| # | Question | Verdict |
|---|---|---|
| **V1** | **How does P2.4 ("one child, one Mac, no rewrite") get satisfied without over-building?** | **Five tables and one discipline.** `household → child → device`, plus `policy_set` sitting between child and device, plus `household_id` denormalised onto every row as the tenancy key. The discipline: **there is no singleton anywhere** — no `WHERE id = 1`, no `CHILD_ID` env var, no implicit "the device". The first household is *claimed* at first run, not seeded. Total cost over a hardcoded design: about 40 lines of schema. |
| **V2** | **Where do rules live — JSONB blob or normalised tables?** | **Both, deliberately split by mutability.** Authoring state is **normalised** (`policy_sets`, `schedule_windows`, `schedule_warnings`, `calendar_exceptions`, `overrides`) so the UI can edit a field and the database can enforce invariants. The wire artefact is a **compiled, immutable, content-addressed row** in `policy_versions` holding the exact document bytes and its JWS. A signature over a re-serialised blob is a signature over nothing. |
| **V3** | **School nights, weekends, holidays, per-day** | Weekly recurrence is `days weekday[]` on a window — exactly T4's wire shape, no translation. **Calendar exceptions compile down into `policy.overrides[]`**, which already exists, already carries a mandatory `expires_at`, and already has an agent implementation. **A holiday needs zero new agent capability.** `date-holidays` (already a `homecal` dependency) is called **live at compile time**, exactly as `homecal` uses it — no mirror table, no sync job. |
| **V4** | **D.4 (budget) without a rewrite** | `policy_sets.kind` is a discriminator (`'windows'` today), and **`schedule_budgets` ships empty on day one** alongside `schedule_windows`. It carries a `meter` column whose default is `active_s`, which is T4-D27's decision recorded in the schema rather than in a comment. Turning on budgets is a feature flag plus an agent state machine — not a migration. |
| **V5** | **Telemetry storage** | **Three layers: raw JSONB landing zone → scheduled projection → rollups.** Raw `events` is append-only and idempotent on `(device_id, event_id)`. Projection runs on a **5-minute schedule keyed off `received_at`, not `ts`**, recomputing whole buckets from scratch so it is idempotent under arbitrary backlog lateness. Reports never read raw. |
| **V6** | **Retention ladder** | **raw `sample` 90 d → raw `audit` 400 d → `usage_hourly` 400 d → `usage_daily` / `session_spans` / `enforcement_log` / `policy_versions` forever.** The hard invariant: **raw sample retention must exceed the agent's `max_queue_age_days`**, or a long outage delivers data that is pruned before it is ever projected. |
| **V7** | **Storage, one child, one Mac, 60 s tick** | **~22 MB/month raw ingest, ~0.35 MB/month rolled up, ~79 MB steady state after year one, ~100 MB after five years.** The house chart's existing **`db.persistence.size: 5Gi`** is already right — **no chart change**. Full arithmetic in §3.6. |
| **V8** | **`agent_status`: a row per device per minute?** | **No — and this is a correction to T4 §9.3.** A row per device per minute is 1,440 rows/day — **26× the row count of everything a report actually reads**, and at a 400-day ladder it would be the **largest table in the database**, roughly doubling its steady-state size — to record a value that changes about eight times a day. The *presence* signal T6 requires is a **log line** (stdout → Loki), which is where T6 actually alerts on it. Postgres stores **intervals** (one row per state change) plus denormalised current state on `devices`. Nothing in T6's alerting changes. |
| **V9** | **Enrolment** | T3's one-time token and T4's better-auth API-key record are the same flow seen from two ends. The single-use guarantee is a **conditional `UPDATE … WHERE consumed_at IS NULL RETURNING`** — never read-then-write. **Enrolments target an existing `device_id`**, which is what makes re-enrolment after a wipe preserve history rather than orphan it. |
| **V10** | **The offline override card** | Generated **server-side per device, served as a file download with `Cache-Control: no-store`**, never as a Next.js route the parent bookmarks. A bookmark points at the cluster; the card exists precisely for when the cluster is gone. |

**The single most consequential thing in this document:**

> **Every relaxation in this system — a parent's +30 minutes, a school holiday, a sleepover, a
> snow day — is the same object: a row in `overrides` with a `NOT NULL expires_at`.**
> That is not tidiness. It is T4-D7's safety invariant expressed as a database constraint, which
> means no feature added later can accidentally create a permanent relaxation, because there is no
> column to put it in.

---

## 1. What this document deliberately does not do

- **It does not redesign T4's contract.** Wire shapes, endpoints, status codes, cadence, failure
  semantics and the desired-state model are taken as given. Where the server needs a field T4 did
  not specify, it is added under T4's own R2 (additive-only) and R4 (capability negotiation), and
  labelled as such.
- **It does not design the agent.** Where agent behaviour is mentioned it is only to say what the
  server must therefore store or send.
- **It does not restate the `home*` template.** Anything a stock sibling app already does is marked
  *as per template* in §4 and gets no further words.
- **It does not carry T4 §10.5.** The "Ask for more time" button is **withdrawn** (constraint C1,
  P1.5). There is no `request.extension` event type, no request table, no request inbox, and no
  child-facing surface of any kind anywhere in this design. The child has no account, no row in
  `user`, and no credential. **By construction she cannot log in**, because she is not an auth
  subject — `children` is a domain table, not an identity table.

---

## 2. T5.1 — Rules data model

### 2.1 The identity chain, and why n=1 is the dangerous case

**P2.4 is the hard requirement here and it is hard for a non-obvious reason.** At n=1 every shortcut
*works*. A `CHILD_ID` env var works. `SELECT * FROM policy LIMIT 1` works. A `devices` table with no
foreign key works. Each of those is one line cheaper today and a two-week refactor the day a second
Mac appears, because by then the shortcut is load-bearing in the API, the UI, the policy compiler,
the projection job and every query in the reporting layer.

So the chain is built properly now, while it costs nothing:

```
  household  ──< household_member >── user (better-auth)        ← parents, and only parents
      │
      ├──< child ──< policy_set ──< schedule_window ──< schedule_warning
      │       │            │
      │       │            └──< schedule_budget          (empty until D.4 says otherwise)
      │       │
      │       ├──< calendar_exception
      │       └──< override                              ← every relaxation, mandatory expires_at
      │
      └──< device ──> child, policy_set
              │
              ├──< policy_version                        ← compiled, immutable, signed artefact
              ├──< enrollment
              ├──< event / usage_hourly / usage_daily / session_span / enforcement_log
              └──< agent_status_interval
```

**Five rules that make this survive growth. [INFERENCE]**

1. **`household_id` is denormalised onto every table**, including the deep ones. It is the tenancy
   key and it is the single most expensive column to add later, because it has to enter every index
   and every `WHERE`. It costs 31 bytes a row now.
2. **Policy is authored against a `child`, not a `device`.** T4's *wire* document is per-device and
   carries `device_id` — that stays true. But the thing a parent edits is "Lucy's rules", and when
   Lucy gets a laptop, bedtime must apply to both without being typed twice. So `policy_set` hangs
   off `child`, `device` points at a `policy_set`, and the compiler fans one policy set out into one
   `policy_version` row per device. **This is the single move that makes "a second Mac" a
   five-second operation instead of a redesign.**
3. **The child is not a user.** No row in better-auth's `user`, no session, no credential, no
   invitation. P0.3 is then not a UI rule that someone could violate with a stray route — it is an
   absence in the identity model.
4. **Nothing is seeded.** The first household is *claimed* at first run (§5.7), not inserted by a
   migration with a fixed UUID. A seeded singleton is a hardcoded identity wearing a costume.
5. **IDs are `uuid().primaryKey().defaultRandom()`, following the house.** **[homecal]** — every
   sibling app uses `uuid` PKs with `generateId: false` in the better-auth config, so Postgres owns
   ID generation. ⚠️ **This is a deliberate, cosmetic deviation from T4's examples**, which show
   prefixed ULIDs (`dev_01JB7ZQK9V8P0X3M2R5T6W`). The wire field is a JSON *string* either way, so
   nothing in the contract changes — and P3.4 (consistency with the `home*` apps) is an explicit
   owner requirement, whereas the ID *spelling* is not. Where prefixed identifiers genuinely earn
   their keep — reading a `pino` line at 03:00 — that is solved by the log field name (`device_id`),
   not by the value.

   **Two carve-outs, both forced by the agent:** `boot_id` is agent-generated and opaque to us, so
   it stays `text()`. `event_id` is `uuid()` **and the ingest normalises** — see §3.1 and conflict
   **X5**, because T4 is internally inconsistent about whether it is a UUID or a ULID, and the two
   spellings of the same 128 bits would defeat the idempotency key.

### 2.2 The authoring / artefact split

This is the second structural decision and it is worth stating before the tables.

| | Authoring state | Wire artefact |
|---|---|---|
| Tables | `policy_sets`, `schedule_windows`, `schedule_warnings`, `calendar_exceptions`, `overrides` | `policy_versions` |
| Mutability | **Mutable.** `UPDATE`s, constraints, `CHECK`s, FKs | **Immutable, append-only.** Never updated, never deleted |
| Shape | Normalised columns | The exact JSON document, plus its compact JWS, plus its ETag |
| Who reads it | The parent UI, the compiler | `GET /policy`, `POST /sync`, and the agent |

**Why not just store the document as JSONB and edit it in place?** Three reasons, all of which bite.

1. **The signature is over bytes.** T4-D5 chose a compact JWS precisely so that verification happens
   over exactly the bytes that were signed, with no JSON-canonicalisation question. If the document
   is re-serialised on the way out, the signature is meaningless. So the bytes must be stored.
2. **A JSONB blob has no invariants.** "Warning leads must be strictly descending", "a window's
   `expires_at` clamp cannot exceed `restricted_until`", "two windows for the same child must not
   overlap on a shared day" — these are `CHECK` constraints and exclusion constraints on real
   columns, and validation prose in a service layer otherwise. T3 §5.5 is explicit: *"Validate on the
   **server** at write time too, so the parent UI rejects an impossible rule before it is ever
   stored. Client-side validation is the backstop, not the gate."* **[T3]**
3. **Rollback needs history.** `policy_versions` is the audit trail and the undo. "Restore Tuesday's
   rules" publishes a *new* version whose content equals an old one. It never mutates history. That
   is `git revert`, and it matches what the owner's Argo CD already does to the cluster **[T4-D24]**.

**The publisher is content-addressed. [INFERENCE — and it matters more than it looks]** Compile →
canonicalise → hash. **If the hash equals the current version's hash, no row is inserted and the
ETag does not change.** Without this, the nightly calendar recompile (§2.4) would mint a new
`policy_version` every single day whether or not anything changed, the ETag would churn, and every
agent would re-download a policy identical to the one it holds. With it, a policy version exists if
and only if something a parent would recognise as a change happened.

### 2.3 Schedules — windows now, a seat for budgets

T4's wire shape is `schedule: { kind: "windows", windows: [...] }` with each window carrying
`days[]`, `restricted_from`, `restricted_until`, `action`, `action_options`, `warnings[]`. **[T4 §4.1]**
The tables mirror it exactly so the compiler is a projection, not a translation.

Three modelling choices worth defending:

- **`days` is a `weekday[]` array of a `pgEnum`, not a bitmask and not a join table. [INFERENCE]**
  It serialises straight to the wire (`["sun","mon","tue","wed","thu"]`), it is readable in `psql`
  when the owner is debugging by hand, and — the deciding reason — Postgres's array overlap operator
  `&&` makes the overlap-validation query exact and one line: two windows conflict iff
  `a.days && b.days` and their time ranges intersect. A bitmask needs `&` plus a comment; a join
  table needs a correlated subquery.
- **Midnight-crossing is explicit, not implied.** `restricted_until <= restricted_from` means the
  window wraps (21:30 → 07:00). That is stored as a **generated column** `crosses_midnight` so the
  UI, the compiler and the validator all read the same fact from one place instead of each
  re-deriving it. Three independent re-derivations of a wrap rule is exactly how an off-by-one-night
  bug ships.
- **`schedule_budgets` exists on day one and is empty.** D.4 is genuinely open **[needs.md §3]**.
  The cost of the empty table is about fifteen lines. The cost of not having it is that the day the
  owner says "actually, 90 minutes a day" the answer is a migration against live data, a new
  discriminator on a table that never had one, and a UI that assumed windows. Its `meter` column
  defaults to `active_s`, which is T4-D27's verdict (*"`active_s` is the number a budget must be
  computed from"*) written into the schema where it cannot be forgotten. **[T4-D27]**

### 2.4 Calendar — school nights, weekends, holidays

The requirement has three levels and they do not need three mechanisms.

| Level | Mechanism |
|---|---|
| School nights vs. weekends | **Two windows** with different `days[]`. Already in T4's shape. Nothing new. |
| Per-day schedules | **N windows.** `days: ["wed"]` is legal. Nothing new. |
| Holidays, half-term, snow days, sleepovers | **`calendar_exceptions`, compiled into `policy.overrides[]`.** |

**The holiday insight, and it is the nicest thing in this document. [INFERENCE]**

A holiday is not a new kind of rule. It is a *relaxation of a known window, for a known date, that
must end*. That is the exact definition of an override — and `policy.overrides[]` already exists in
the contract, already carries a **mandatory `expires_at`**, already has agent-side semantics, and is
already merged with local grants by the union rule **[T8 §4.7]**. So:

- `effect: 'treat_as_weekend'` → an `extend` override for that date, `minutes` = the delta between
  the weekday and weekend window starts.
- `effect: 'no_bedtime'` → a `suspend` override for that date.
- `effect: 'custom'` → an `extend` override with explicit minutes.

**Consequences, all good:**

- **Zero new agent capability.** An agent that understands overrides understands holidays.
- **Holidays cannot become permanent**, because the override row has no nullable `expires_at`.
- **A holiday appears in the audit trail and the report** as "+60 min, calendar: Christmas Day",
  which is exactly what a parent wants to see when they ask why Tuesday looks odd.
- **The stale-policy behaviour is correct and self-evidently safe.** The compiler emits a rolling
  **21-day horizon** of exceptions. If the Mac is offline for a month over the summer, the compiled
  exceptions age out and the baseline school-night schedule reasserts itself. T4-D7's "staleness can
  only ever converge stricter" holds for holidays too, for free. **[T4 §8.3]**

`granted_via` gains one value: **`'calendar'`**, alongside T8's `'ui'` and `'offline_code'`. Under
T4's R5 an agent that does not know the value degrades it to `'ui'` and logs — harmless, because the
grant itself is an ordinary `extend`/`suspend`. **[T8 §4.2, T4 R5]**

**`date-holidays` — copy `homecal`'s usage exactly, including the part I was about to get wrong.**
`homecal` depends on `date-holidays@^3.27.0` and uses it in exactly one file,
`apps/api/src/services/holidays.ts`: per-country `new Holidays(cc)` instances cached for process
lifetime, `hd.getHolidays(year)` filtered to `h.type === "public"`, a 100-entry FIFO result cache,
and — the important part — **no database table, no sync job, no country-list constant. Everything is
computed on the fly.** **[homecal]**

My first instinct was a nightly job upserting `calendar_exceptions` rows with `source = 'holidays'`.
**That is wrong and the house is right.** A persisted mirror of a pure function creates an
idempotency problem, a staleness problem and a "the library renamed a holiday and now there are two"
problem, all for a value that costs microseconds to recompute. So:

> **`calendar_exceptions` stores parent *intent* only** — a row exists because a human added, edited
> or **dismissed** something. The compiler calls the `holidays` service live and merges.

Resolution order at compile time: **a manual row for a date always wins; a `dismissed` row
suppresses the library's holiday for that date; otherwise the library's public holidays apply, if
`households.holidaysEnabled`.** "The bank is shut" and "she has no school" are different facts, and
the parent needs one click to say so — in both directions. `households.holidayCountries` is
`text().array()`, mirroring `users.holidayCountries` in `homecal` **[homecal]**, so the same
multi-country merge logic applies unchanged.

**What a calendar exception cannot do: make bedtime earlier.** Overrides are relaxations only —
there is no tightening primitive in `policy.overrides[]`, by design. A genuinely earlier bedtime
("school trip, 06:00 start") is a **schedule change**: a new `policy_version`, subject to
`confirm_immediate_effect` if it bites within 15 minutes **[T4-D17]**. That is correct and should
not be softened: tightening enforcement is the dangerous direction and deserves the guard.

### 2.5 Overrides — and the one table split that prevents a real bug

Three tables, not one, and the reason is T8-D13.

| Table | Holds | Compiled into `policy.overrides[]`? |
|---|---|---|
| `overrides` | Server-issued grants: parent clicks, calendar exceptions | ✅ **Yes** |
| `override_redemptions` | Offline codes the *device* reports having redeemed | ❌ **Never** |
| `override_code_reveals` | Codes the parent's offline card says it displayed | ❌ Never — reconciliation only |

T8 §6.3 is emphatic: ***"The server must NOT convert a redeemed offline grant into a
`policy.overrides[]` entry. By reconciliation time it has usually expired, and re-issuing it would
silently extend it. It is history."*** **[T8]**

If redemptions and grants shared a table with a `granted_via` discriminator, that rule would be one
forgotten `WHERE` clause away from being violated, and the symptom — a 30-minute grant that
mysteriously re-arms itself an hour after the child used it — would be maddening to reproduce.
**Two tables makes the bug unrepresentable.** This is the same style of argument as T4-D26 (the
schema cannot express disabling Remote Login) and T8 §7.1 (the schema cannot express suspending the
morning boundary), applied one level up.

**Semantics, all taken from T8 §7 unchanged. [T8]**

| `type` | Meaning | Clamp |
|---|---|---|
| `extend` | Move one named window's **start** boundary later by N minutes, for one date. The only type an offline code can produce | `expires_at` ≤ that window's `restricted_until` |
| `suspend` | No enforcement of that window that night (sleepover, holiday). UI/calendar only, never code-redeemable, separate confirmation | `expires_at` ≤ that window's `restricted_until` |
| `grant_minutes` | +N minutes to today's budget — the D.4 seat | `expires_at` ≤ end of the local day |

Caps live in the policy document (`max_minutes_per_day: 120`, `max_grants_per_day: 3`,
`allowed_minutes: [15,30,60]`) and are **enforced in the agent so they hold offline** **[T8 §5.4]**.
The server enforces them too, at write time, because a server that will happily issue a 6-hour grant
while the agent silently clamps it to 60 minutes produces a UI that lies.

### 2.6 What the schema cannot express — safety by construction

T4-D26 is a hard invariant and the schema is where it is enforced **[T4-D26]**:

> The policy document has no field that can disable Remote Login, modify or disable an admin
> account, alter `sudoers`, or change FileVault state.

**⚠️ House convention collides with this, and I am deviating once, deliberately.** `homecal`,
`homework` and `homenews` contain **zero `pgEnum`s** — status, role and channel columns are plain
`text()` with a default, and the enum is enforced app-side by Zod **[homecal]**. That is a fine
convention for `status: 'pending' | 'sent'`. It is the wrong convention for a column whose values
are *"lock this child's computer"* and *"power it off"*, because Zod validation lives in the process
that could have the bug.

**The deviation, scoped to exactly one column: `schedule_windows.action` carries a `CHECK`
constraint.** Not a `pgEnum` — a `CHECK` is the minimum-blast-radius form (no type to create,
no type to migrate, no `ALTER TYPE … ADD VALUE` ceremony, and `drizzle-orm` exposes `check()` in
the table-extras array so it is one line). One deviation, one line, named here so a reviewer can
see it was a decision and not an accident.

Concretely, in these tables:

- **`schedule_windows.action` is `text()` + `check(action IN ('warn_only','lock','shutdown'))`.**
  A future contributor cannot add `'disable_remote_login'` without writing a migration, and a
  migration is a code review. Everything else stays house-standard `text()` + Zod.
- **There is no generic `commands` table and no `agent_config` JSONB free-for-all.** T4 deleted the
  command channel outright **[T4-D24]**; reintroducing a general key/value escape hatch server-side
  would smuggle it back in. Every piece of desired state has a typed home.
- `action_options` is not free-form JSONB either; it is two typed columns
  (`shutdownGraceS`, `escalateAfterFailures`).
- **`overrides.expiresAt` is `.notNull()`.** T4-D7 as a column constraint. **No deviation needed —
  this one is free.**
- **There is no `enforcement_enabled` boolean anywhere in the policy path.** See §7 conflict **X1** —
  this is a real contradiction between T3 and T4 and it is resolved in T4's favour.

⚠️ **The honest limit**, so nobody mistakes this for a security boundary: none of it resists the
child, who has admin and can `sudo touch /var/db/homeparentcontrol/DISABLE` **[T8 §5.2]**. It resists
*us* — a bad policy push, a careless feature, a fat-fingered edit. That is what T4-D26 was for, and
AR.1 covers the rest.

### 2.7 The schema — `apps/api/src/db/schema.ts` (rules half)

**House conventions followed** **[homecal]**: one schema file (not split), `uuid().primaryKey().defaultRandom()`,
`timestamp({ withTimezone: true })`, camelCase TS keys, snake_case plural table names, the
drizzle-0.45 array form for the third `pgTable` argument, index names `<table>_<cols>_idx` and
`<table>_<cols>_unique`, `onDelete: "cascade"` as the default posture, a trailing `relations()`
block, and `.js` extensions on every import.

**One house decision to make on day zero:** set **`casing: "snake_case"`** in *both*
`drizzle.config.ts` and the `drizzle()` call, following `homework` — the newest generation. `homecal`
predates it and has camelCase quoted columns; `homework`'s `knowledge/drizzle-casing-onconflict.md`
records that a mismatch makes `onConflictDoUpdate` silently no-op and then throw duplicate-key, and
that changing it later means regenerating every migration **[homecal]**. ⚠️ Caveat worth 15 minutes
on day one: **`homework` has no auth, so `casing: "snake_case"` has never been run against
better-auth's drizzle adapter in this house.** It should work — the adapter addresses columns by
their TS key and drizzle does the mapping — but verify it before migration 0001: sign up, create a
session, mint an API key, then `\d+ sessions` and confirm `user_id`, not `"userId"`. `homecal`'s
camelCase is the zero-risk fallback.

```ts
import { relations, sql, type SQL } from "drizzle-orm";
import {
  boolean, check, date, index, integer, jsonb, pgTable, smallint,
  text, time, timestamp, unique, uuid,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Better Auth core tables — users / sessions / accounts / verifications /
// apikeys — copied from homecal's schema.ts verbatim. NOT REPRODUCED HERE.
// See §4 "as per template". Two fields matter to this app and are called out
// in §4.2: `users.isService` and the NOT NULL `apikeys.userId`.
// ─────────────────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════
// IDENTITY — household → child → device.  P2.4: n=1 today, no rewrite later.
// ═════════════════════════════════════════════════════════════════════════════

export const households = pgTable("households", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  // IANA name, never a UTC offset (T4-D12). Inherited by children unless overridden.
  timezone: text().notNull().default("America/New_York"),
  // Mirrors homecal's users.holidayCountries. Drives the live date-holidays merge (§2.4).
  holidayCountries: text().array(),
  holidaysEnabled: boolean().notNull().default(true),
  // The one service user that owns every device API key. See §4.2 — a device
  // credential must NOT hang off a human parent, because apikeys.userId is
  // NOT NULL ON DELETE CASCADE and removing that parent would silently revoke
  // every device in the house.
  serviceUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const householdMembers = pgTable(
  "household_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    // "owner" | "parent" — enforced by Zod, house convention (no pgEnum).
    role: text().notNull().default("parent"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("household_members_household_id_idx").on(t.householdId),
    unique("household_members_household_user_unique").on(t.householdId, t.userId),
  ],
);

// The child is a DOMAIN row, never an auth subject. She has no `users` row, no
// session and no credential — so P0.3 ("no management or viewing surface for
// the child") is an absence in the identity model, not a UI rule someone can
// violate with a stray route.
export const children = pgTable(
  "children",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    displayName: text().notNull(),
    // NULL = inherit household.timezone. This is policy.timezone on the wire.
    timezone: text(),
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
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    childId: uuid().notNull().references(() => children.id, { onDelete: "restrict" }),
    // The policy the compiler renders for this device. Two Macs can share one.
    policySetId: uuid().references(() => policySets.id, { onDelete: "restrict" }),
    label: text().notNull(), // "Lucy's Mac mini"

    // Physical identity. Stable across an OS reinstall — this is what makes
    // re-enrolment after a wipe preserve history instead of orphaning it (§5.5).
    hardwareUuid: text(),
    hostname: text(),
    model: text(),

    // Administrative lifecycle. ORTHOGONAL to health state (T4 §9.4): a REVOKED
    // device is still alive and still enforcing. Values: pending | active |
    // revoked | decommissioned.
    status: text().notNull().default("pending"),

    // The one live API key. NULL between revoke and re-enrol.
    apiKeyId: uuid().references(() => apikeys.id, { onDelete: "set null" }),

    // ── Denormalised current state, written by the sync handler every tick.
    //    Kept here rather than joined from agent_status_intervals so the
    //    "Today" page is one row read. See §3.4.
    lastSyncAt: timestamp({ withTimezone: true }),
    lastTickSeq: integer(),
    lastBootId: text(),
    systemBootTime: timestamp({ withTimezone: true }), // T4-D28: gap attribution
    agentVersion: text(),
    osVersion: text(),
    arch: text(),
    appliedPolicyVersion: integer(),
    healthState: text().notNull().default("UNENROLLED"), // T6's five states
    healthReason: text(),
    healthSince: timestamp({ withTimezone: true }),

    // T4 §9.6 / V8 — handed to T6, never answered. Adopted here. Forces
    // EXPECTED_OFFLINE so a school holiday cannot make SILENT_TOO_LONG fire
    // benignly and get the channel muted. NOT an override: an away device must
    // still enforce bedtime the moment it is switched on.
    awayUntil: timestamp({ withTimezone: true }),

    // Server-side sticky flag behind T4's `attended` 5 s cadence (T4 §2).
    attendedUntil: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("devices_household_id_idx").on(t.householdId),
    index("devices_child_id_idx").on(t.childId),
    // Not globally unique: a decommissioned device keeps its hardwareUuid so a
    // replacement can be recognised. Uniqueness is enforced in the enrol handler
    // against status IN ('pending','active','revoked'). See §5.5.
    index("devices_hardware_uuid_idx").on(t.hardwareUuid),
  ],
);

// ═════════════════════════════════════════════════════════════════════════════
// RULES — authoring state.  Mutable, constrained, edited by the parent UI.
// ═════════════════════════════════════════════════════════════════════════════

export const policySets = pgTable(
  "policy_sets",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
    name: text().notNull().default("Default"),

    // D.4's discriminator. "windows" today; "budget" turns on schedule_budgets
    // with no migration. Zod-enforced (house convention).
    kind: text().notNull().default("windows"),

    // T4 §4.1 policy-document scalars that are genuinely per-child policy.
    failMode: text().notNull().default("open"), // O.1: open | closed, per device-set
    agentLogLevel: text().notNull().default("info"),
    diagnosticsRetentionDays: integer().notNull().default(7),

    // T4 §2 cadence
    pollBaseIntervalS: integer().notNull().default(60),
    pollBoundaryIntervalS: integer().notNull().default(15),
    pollBoundaryLeadS: integer().notNull().default(900),

    // T8 §4.1 override block
    overrideEnabled: boolean().notNull().default(true),
    overrideAllowedMinutes: smallint().array().notNull().default([15, 30, 60]),
    overrideMaxMinutesPerDay: integer().notNull().default(120),
    overrideMaxGrantsPerDay: integer().notNull().default(3),
    offlineCodesEnabled: boolean().notNull().default(false), // ships off; see §5.6
    offlineCodeDigits: smallint().notNull().default(6),
    offlineCodeDayWindow: smallint().notNull().default(1),
    offlineCodeMaxSeqPerBucket: smallint().notNull().default(3),
    offlineCodeAttemptsPerWindow: smallint().notNull().default(5),
    offlineCodeAttemptWindowS: integer().notNull().default(900),

    // T4 §4.1 telemetry block — the agent's own queue caps, not ours (§3.5).
    telemetryEnabled: boolean().notNull().default(true),
    telemetrySampleIntervalS: integer().notNull().default(60),
    telemetryCollect: text().array().notNull()
      .default(["session.state", "enforcement.*", "app.usage_sample"]),
    telemetryMaxQueueEvents: integer().notNull().default(50000),
    telemetryMaxQueueBytes: integer().notNull().default(33554432),
    telemetryMaxQueueAgeDays: integer().notNull().default(14),
    telemetryAuditRetentionDays: integer().notNull().default(90),

    stalenessWarnAfterS: integer().notNull().default(86400),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("policy_sets_child_id_idx").on(t.childId),
    // T4 §8.3 / T8 §7.3 hard ceilings, at the database. A server that will
    // happily store a 6-hour grant cap while the agent clamps to 60 minutes
    // produces a UI that lies.
    check("policy_sets_override_caps_check", sql`
      ${t.overrideMaxMinutesPerDay} BETWEEN 0 AND 480
      AND ${t.overrideMaxGrantsPerDay} BETWEEN 0 AND 10
    `),
  ],
);

export const scheduleWindows = pgTable(
  "schedule_windows",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    policySetId: uuid().notNull().references(() => policySets.id, { onDelete: "cascade" }),
    label: text().notNull(), // "School nights", "Weekend" — becomes window id on the wire

    // Wire-identical: ["sun","mon","tue","wed","thu"]. Overlap validation is one
    // line with the Postgres array-overlap operator: a.days && b.days.
    days: text().array().notNull(),

    restrictedFrom: time().notNull(),  // "21:30"
    restrictedUntil: time().notNull(), // "07:00"
    // Derived once so the UI, the compiler and the validator cannot each
    // re-derive the wrap rule slightly differently.
    crossesMidnight: boolean().generatedAlwaysAs(
      (): SQL => sql`${scheduleWindows.restrictedUntil} <= ${scheduleWindows.restrictedFrom}`,
    ),

    // THE ONE DEVIATION FROM THE HOUSE "no DB enums" CONVENTION (§2.6).
    // T4-D26: the policy schema must not be able to express anything that
    // could lock the parent out. This is the column that can power off a
    // child's computer; its domain belongs in the database, not in a Zod
    // schema living inside the process that might have the bug.
    action: text().notNull().default("lock"),

    shutdownGraceS: integer().notNull().default(300),      // T4-D25
    escalateAfterFailures: smallint().notNull().default(3),

    sortOrder: smallint().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("schedule_windows_policy_set_id_idx").on(t.policySetId),
    check("schedule_windows_action_check",
      sql`${t.action} IN ('warn_only', 'lock', 'shutdown')`),
    check("schedule_windows_days_check",
      sql`${t.days} <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[]
          AND array_length(${t.days}, 1) >= 1`),
    check("schedule_windows_distinct_bounds_check",
      sql`${t.restrictedFrom} <> ${t.restrictedUntil}`),
    check("schedule_windows_grace_check", sql`${t.shutdownGraceS} BETWEEN 0 AND 3600`),
  ],
);

export const scheduleWarnings = pgTable(
  "schedule_warnings",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    windowId: uuid().notNull().references(() => scheduleWindows.id, { onDelete: "cascade" }),
    leadMinutes: smallint().notNull(),
    // "banner" | "modal" — T8's override button rides the modal (T8 §2.3).
    channel: text().notNull().default("modal"),
  },
  (t) => [
    index("schedule_warnings_window_id_idx").on(t.windowId),
    unique("schedule_warnings_window_lead_unique").on(t.windowId, t.leadMinutes),
    check("schedule_warnings_lead_check", sql`${t.leadMinutes} BETWEEN 1 AND 240`),
  ],
);

// D.4's seat. Ships EMPTY. ~15 lines now; a migration against live data later.
// `meter` defaults to active_s because T4-D27 settled that an idle app left
// open overnight must not burn a budget — recorded in the schema so it cannot
// be forgotten when someone finally builds this.
export const scheduleBudgets = pgTable(
  "schedule_budgets",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    policySetId: uuid().notNull().references(() => policySets.id, { onDelete: "cascade" }),
    days: text().array().notNull(),
    budgetMinutes: integer().notNull(),
    meter: text().notNull().default("active_s"), // active_s | foreground_s
    resetAt: time().notNull().default("04:00"),
    action: text().notNull().default("lock"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("schedule_budgets_policy_set_id_idx").on(t.policySetId),
    check("schedule_budgets_action_check",
      sql`${t.action} IN ('warn_only', 'lock', 'shutdown')`),
    check("schedule_budgets_meter_check",
      sql`${t.meter} IN ('active_s', 'foreground_s')`),
  ],
);

// T4 §4.1 `expected_online` — drives EXPECTED_OFFLINE, NOT enforcement.
export const expectedOnlineWindows = pgTable(
  "expected_online_windows",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    policySetId: uuid().notNull().references(() => policySets.id, { onDelete: "cascade" }),
    days: text().array().notNull(),
    fromTime: time().notNull(),
    untilTime: time().notNull(),
  },
  (t) => [index("expected_online_windows_policy_set_id_idx").on(t.policySetId)],
);

// Parent INTENT only. The date-holidays library is called live at compile time
// (§2.4) — this table never mirrors it. A row exists because a human added,
// edited or dismissed something.
export const calendarExceptions = pgTable(
  "calendar_exceptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    // NULL = every child in the household.
    childId: uuid().references(() => children.id, { onDelete: "cascade" }),
    day: date().notNull(),

    // treat_as_weekend | no_bedtime | custom | dismiss_holiday
    effect: text().notNull(),
    // For custom / treat_as_weekend: how much later the start boundary moves.
    extendMinutes: integer(),
    // NULL = every window in the policy set (the usual case).
    windowId: uuid().references(() => scheduleWindows.id, { onDelete: "cascade" }),

    note: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendar_exceptions_household_day_idx").on(t.householdId, t.day),
    unique("calendar_exceptions_child_day_window_unique").on(t.childId, t.day, t.windowId),
    check("calendar_exceptions_effect_check",
      sql`${t.effect} IN ('treat_as_weekend', 'no_bedtime', 'custom', 'dismiss_holiday')`),
    check("calendar_exceptions_minutes_check",
      sql`${t.effect} <> 'custom' OR ${t.extendMinutes} > 0`),
  ],
);

// ═════════════════════════════════════════════════════════════════════════════
// OVERRIDES — every relaxation in the system, and the one NOT NULL that makes
// "a stale policy applies forever" safe by construction (T4-D7).
// ═════════════════════════════════════════════════════════════════════════════

export const overrides = pgTable(
  "overrides",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
    // NULL = all of that child's devices. Set for a per-device grant.
    deviceId: uuid().references(() => devices.id, { onDelete: "cascade" }),

    // extend | suspend | grant_minutes   (T8 §7.1)
    type: text().notNull().default("extend"),
    windowId: uuid().references(() => scheduleWindows.id, { onDelete: "cascade" }),
    minutes: integer(),
    effectiveDate: date().notNull(),

    // ★ T4-D7. THE load-bearing constraint in this schema. There is no column
    //   in which to store "never expires", so no feature added later can
    //   create a permanent relaxation. Staleness can only converge stricter.
    expiresAt: timestamp({ withTimezone: true }).notNull(),

    // ui | calendar.  NOT 'offline_code' — those live in override_redemptions
    // and are never compiled back into policy.overrides[] (T8-D13, §2.5).
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
    check("overrides_type_check",
      sql`${t.type} IN ('extend', 'suspend', 'grant_minutes')`),
    check("overrides_granted_via_check",
      sql`${t.grantedVia} IN ('ui', 'calendar')`),
    check("overrides_minutes_check",
      sql`${t.type} = 'suspend' OR ${t.minutes} > 0`),
  ],
);

// History of offline codes the DEVICE reports redeeming. NEVER compiled into
// policy.overrides[] — T8 §6.3: "By reconciliation time it has usually expired,
// and re-issuing it would silently extend it. It is history."
export const overrideRedemptions = pgTable(
  "override_redemptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    localGrantId: text().notNull(),     // the agent's lov_… id
    overrideKeyId: uuid().references(() => overrideKeys.id, { onDelete: "set null" }),
    bucketDay: date().notNull(),        // the (day, minutes, seq) HOTP counter
    bucketMinutes: smallint().notNull(),
    bucketSeq: smallint().notNull(),
    windowId: uuid().references(() => scheduleWindows.id, { onDelete: "set null" }),
    redeemedAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    clockTrusted: boolean().notNull().default(true),
    serverReachable: boolean().notNull().default(false),
    // matched | unmatched | no_reveal_record      ← see §7 conflict X3
    reconciliation: text().notNull().default("pending"),
    reconciledAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("override_redemptions_device_redeemed_at_idx").on(t.deviceId, t.redeemedAt),
    unique("override_redemptions_device_bucket_unique")
      .on(t.deviceId, t.bucketDay, t.bucketMinutes, t.bucketSeq),
  ],
);

// What the parent's offline card says it displayed. Flushed opportunistically
// when the phone next has the LAN. This is what makes T8 §5.4's
// `override.unmatched` alert possible at all — see §7 conflict X3, because as
// T8 wrote it, it is not.
export const overrideCodeReveals = pgTable(
  "override_code_reveals",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    overrideKeyId: uuid().notNull().references(() => overrideKeys.id, { onDelete: "cascade" }),
    bucketDay: date().notNull(),
    bucketMinutes: smallint().notNull(),
    bucketSeq: smallint().notNull(),
    revealedAt: timestamp({ withTimezone: true }).notNull(),
    reportedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    reportedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("override_code_reveals_device_bucket_unique")
      .on(t.deviceId, t.bucketDay, t.bucketMinutes, t.bucketSeq),
  ],
);

// K_ovr. Delivered to the agent via desired[] (T8 §4.3), never via the policy
// cache. `secret` is the ONE genuinely sensitive column in this database.
export const overrideKeys = pgTable(
  "override_keys",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    secret: text().notNull(),            // base64url(32 random bytes)
    alg: text().notNull().default("HMAC-SHA256"),
    notAfter: timestamp({ withTimezone: true }).notNull(),   // 30-day rotation
    activatedAt: timestamp({ withTimezone: true }),          // set on convergence
    retiredAt: timestamp({ withTimezone: true }),            // 24 h dual-key overlap
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("override_keys_device_id_idx").on(t.deviceId)],
);

// ═════════════════════════════════════════════════════════════════════════════
// THE WIRE ARTEFACT — immutable, append-only, content-addressed.
// ═════════════════════════════════════════════════════════════════════════════

export const policyVersions = pgTable(
  "policy_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    policySetId: uuid().notNull().references(() => policySets.id, { onDelete: "restrict" }),

    // Monotonic PER DEVICE. A regression is a tripwire (T4 §6.8).
    version: integer().notNull(),

    // The EXACT document. Never re-serialised on the way out — the JWS is a
    // signature over these bytes and nothing else (T4-D5).
    document: jsonb().notNull(),
    // sha256(canonical JSON). If it equals the current version's hash the
    // compiler inserts NOTHING — this is what stops the nightly calendar
    // recompile minting a new version (and churning the ETag) every day.
    documentHash: text().notNull(),
    jws: text(),                       // NULL when policy signing is disabled
    signingKeyId: text(),
    etag: text().notNull(),            // W/"pol-<hash12>-v<version>"

    issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    notBefore: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // T4-D17 blast-radius guard. Set true ONLY when the parent confirmed a
    // TIGHTENING that bites within 15 min. Relaxations are exempt (T8/C3) —
    // otherwise every +30 min grant pops the dialog and trains the parent to
    // click through the one case it was built for.
    confirmImmediateEffect: boolean().notNull().default(false),

    publishedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    publishReason: text(),             // "schedule_edit" | "override" | "calendar" | "restore"
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("policy_versions_device_version_unique").on(t.deviceId, t.version),
    index("policy_versions_device_created_at_idx").on(t.deviceId, t.createdAt),
    index("policy_versions_etag_idx").on(t.etag),
  ],
);

// T4 §4.6(b): per-device operational intent that must NOT be persisted into the
// policy cache — because it is transient, or because it carries a secret.
// Re-sent EVERY tick until the server OBSERVES convergence (T4 §4.6 rule 3).
// `kind` is Zod-constrained to exactly the five kinds T4 and T8 specify; there
// is deliberately no generic escape hatch (§2.6).
export const desiredItems = pgTable(
  "desired_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    // credential | diagnostics | self_test | override_key | agent_version
    kind: text().notNull(),
    spec: jsonb().notNull(),
    // pending | converged | unsupported      (T4 R6: unsupported is TERMINAL)
    status: text().notNull().default("pending"),
    unsupportedDetail: text(),
    observedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("desired_items_device_status_idx").on(t.deviceId, t.status),
    check("desired_items_kind_check", sql`${t.kind} IN
      ('credential', 'diagnostics', 'self_test', 'override_key', 'agent_version')`),
  ],
);

export const enrollments = pgTable(
  "enrollments",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    // sha256 of the normalised code. The plaintext is shown ONCE and never stored.
    codeHash: text().notNull(),
    // "HPC-K7QM" — enough for the UI to say which outstanding code this is.
    codeHint: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    // The single-use guarantee is `UPDATE … WHERE consumed_at IS NULL RETURNING`,
    // never read-then-write. See §5.3.
    consumedAt: timestamp({ withTimezone: true }),
    consumedIp: text(),
    consumedHardwareUuid: text(),
    // Set when a retry of the SAME code from the SAME hardware re-issues a
    // credential because the first one was never observed in use (§5.4 case ii).
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
```

### 2.8 The policy compiler, in eleven lines of pseudocode

```
compile(device) →
  set        = policySets[device.policySetId]
  tz         = child.timezone ?? household.timezone
  windows    = scheduleWindows[set] + their scheduleWarnings
  horizon    = today … today + 21 days                       # §2.4
  holidays   = holidaysService.get(household.holidayCountries, horizon)   # live, homecal's service
  exceptions = merge(calendarExceptions[horizon], holidays)  # manual > dismiss > library
  grants     = overrides WHERE child = … AND revoked_at IS NULL
                                     AND expires_at > now()  # ← the NOT NULL earns its keep
  doc        = { policy_version: next, device_id, subject, timezone: tz,
                 fail_mode, poll, agent, schedule: {kind, windows},
                 overrides: grants ∪ exceptionsAsOverrides,
                 expected_online, telemetry, staleness, override }
  hash       = sha256(canonicalJson(doc))
  if hash == currentVersion.documentHash: RETURN unchanged   # ← kills recompile churn
  sign(doc) with Ed25519 → jws ; INSERT policy_versions ; bump ETag
```

**Three properties this buys.** The compiler is a **pure function** of authoring state plus the
date, so it is unit-testable with no database and no clock injection beyond one argument — which
matters, because T3 §5.1 records that POC 1's two bugs were both on the enforcement path and *"the
dry-run suite caught neither"*. The output is **content-addressed**, so no change means no version.
And **calendar exceptions and parent grants land in the same array**, which means there is exactly
one code path for "something relaxed the rules" — on both ends of the wire.

---

## 3. T5.2 — Telemetry storage, retention and aggregation

### 3.0 The premise, restated because it drives everything

T1 measured what macOS keeps, live on the target spec **[T1]**:

| Source | Retention observed |
|---|---|
| `pmset -g log` | **≈ 7 days** |
| unified log | ≈ 30 days *queryable*, but only **≈ 1.5 days dense** at real logging volume |
| `last` / wtmp | ≈ 11 months — but session boundaries only |
| `knowledgeC.db` (Apple's own aggregate) | Full Disk Access, and Apple is vaulting it release over release |

> *"Anything needing longer retention must be collected and stored by us, not read back from the
> OS."* **[T1]**

So there is no fallback. If the control plane loses a week of telemetry, that week is gone from the
universe — nobody can re-read it off the Mac. That single fact is why the ingest path is designed for
**idempotent at-least-once** rather than for throughput, why the raw landing zone outlives the
agent's own queue by 3×, and why every eviction and every gap is recorded as a **positive event**
rather than showing up as an unexplained hole in a chart.

### 3.1 Ingest — `POST /api/agent/v1/events`

**One table, one conflict clause, and nothing clever.**

```sql
INSERT INTO events (household_id, device_id, event_id, type, v, class, ts, received_at, boot_id, seq, data)
VALUES … ON CONFLICT (device_id, event_id) DO NOTHING
RETURNING event_id;
```

The `RETURNING` is what populates `accepted_event_ids[]`. **The agent deletes only what the server
names** **[T4 §7.3]**, so a row that conflicts is still *accepted* — it is already durable. Returning
only the newly-inserted rows would make the agent retry the same batch forever.

Implementation notes that are not obvious:

- **Batch as a single multi-row `INSERT`, not a loop.** `postgres-js` (the house driver — **not
  `pg`** **[homecal]**) handles a 2,000-row values list fine. A per-row loop turns a 2,000-event
  backlog drain into 2,000 round-trips.
- **Validate per event, not per batch.** A batch that fails `safeParse` as a unit gives no vocabulary
  for *"I took 1,998 of your 2,000 and rejected 2 as malformed"*, which is exactly what
  `rejected_events[]` needs **[T4 §7.3]**. Partition first, insert the good ones, report the rest.
- **R1: never call `.strict()`** on anything under the agent contract. Zod's default `.parse()`
  already strips unknown keys. This should be a lint rule on the contract module **[T4 R1]**.
- **Unknown `type` is stored, never rejected**, and increments an `unknown_event_type` counter
  **[T4 R8]**. This is the mechanism by which D.1 (monitoring depth) lands later without a flag day.
- ⚠️ **Normalise `event_id` before insert.** See conflict **X5**: T4's R8 says UUIDv7 while its own
  examples show 26-character Crockford ULIDs. Those are the same 128 bits in two spellings, and if
  both reach the table the `UNIQUE (device_id, event_id)` idempotency key **silently stops working**
  — the same event arrives twice under two names, reports double-count, and nothing errors. One
  helper, called on the way in, converting either spelling to a canonical `uuid`.

**Indexes on `events`, and deliberately only these three:**

| Index | For |
|---|---|
| `UNIQUE (device_id, event_id)` | Idempotency. Non-negotiable. |
| `(device_id, ts)` | The projector's bucket recompute, and ad-hoc `psql` archaeology. |
| `BRIN (received_at)` | The retention prune. A BRIN over an append-ordered timestamp is a few kilobytes and turns `DELETE … WHERE received_at < …` from a seq scan into a block-range scan. |

No `(device_id, type, ts)` btree. It would cost ~20 % of total storage to serve queries that the
rollups already answer, and the rollups are the point.

### 3.2 Projection — scheduled, watermarked, and idempotent under arbitrary lateness

**Raw events are not what a report reads.** The projector turns `(type, v)` pairs it recognises into
typed rollup rows and leaves everything else sitting in JSONB **[T4 R8]**.

**It runs on a schedule, not on ingest.** Three reasons: the ingest path must stay the cheapest thing
the server does, so a 24,000-event backlog drain cannot stall behind aggregation; a projection bug
becomes *"re-run the projector"* rather than *"re-ingest data you no longer have"*; and T4's R8
explicitly permits *"on a schedule or on read"*.

**The hard part is lateness, and it has one correct answer.**

The agent queues up to ~29 days of events on disk **[T4 §7.2]**. When a fortnight's backlog drains,
buckets from two weeks ago need updating. So:

```
every 5 minutes:
  w      = projection_state.watermark_received_at            # server clock, monotonic-ish
  rows   = events WHERE received_at > w ORDER BY received_at LIMIT 50_000
  dirty  = distinct (device_id, date_trunc('hour', ts)) over rows
  for each dirty bucket:
      RECOMPUTE THE WHOLE BUCKET from events, then upsert     # ← not "add the new rows"
  projection_state.watermark_received_at = max(rows.received_at)
```

**Recomputing the bucket rather than incrementing it is the whole design.** An incremental projector
must know whether it already counted a row, which means per-row bookkeeping, which means a second
idempotency problem on top of the one `event_id` already solves. A full recompute is idempotent by
construction: run it once, run it fifty times, same answer. At ~85 rows per bucket it costs nothing.

**Keyed off `received_at`, never `ts`.** The agent's `ts` is advisory — T4 §7.3 says so outright,
because the local clock is not trustworthy and a child stepping it backwards would otherwise let
events slip permanently behind a `ts`-based watermark and never be projected at all.

**The invariant this creates**, and it is a genuine footgun if missed:

> **`RAW_SAMPLE_RETENTION_DAYS` must exceed the agent's `telemetry.max_queue_age_days`.**
> Otherwise a long outage delivers events that are ingested and then pruned *before* the projector
> touches them — data that arrived, was stored, and evaporated, with no error anywhere.
> 90 versus 14–29 gives 3× headroom. Assert it at boot and refuse to start if it is violated.

A nightly job additionally re-projects the trailing 48 hours unconditionally, which costs ~2,000 row
reads and absorbs anything the watermark logic got wrong.

### 3.3 Rollups — what a report actually reads

**T1's free permission tier is the entire input set**, and it is enough to ship **[T1]**: foreground
app bundle ID (`lsappinfo` / `NSWorkspace`), per-process CPU (`ps %cpu`), idle (`ioreg`
`HIDIdleTime`), console user, and power/session events — **zero TCC grants, zero dollars**.

| Rollup | Grain | Source event types | Retention |
|---|---|---|---|
| `usage_hourly` | `(device, hour, bundle_id)` | `app.usage_sample` v1+ | 400 d |
| `usage_daily` | `(device, local_day, bundle_id)` | derived from `usage_hourly` | **forever** |
| `session_spans` | one row per contiguous awake/active span | `session.state`, `power.*`, `agent.started/stopping` | **forever** |
| `enforcement_log` | one row per audit-class enforcement fact | `enforcement.*`, `policy.*`, `clock.*`, `override.*`, `queue.evicted` | **forever** |

**`usage_daily` is keyed on the *local* day, in `policy.timezone`, not UTC.** Getting this wrong
produces a report where Sunday evening's Minecraft shows up on Monday, which is the first thing a
parent will notice and the last thing anyone will think to check. Derive it from `usage_hourly` with
the zone applied at derivation time — never `date_trunc('day', ts)` in UTC.

**`active_s` versus `foreground_s`, and why the sum is safe.** T4-D27 puts three numbers on the wire:
`foreground_s` (wall time frontmost), `active_s` (seconds the session was not idle, from
`HIDIdleTime`), and `cpu_pct_avg`. **Only one app is frontmost at a time, so per-app `active_s` are
disjoint** — `SUM(active_s)` over a day's rows is the correct daily total, not an over-count. Worth a
comment in the schema, because it looks wrong at first glance and someone will "fix" it.

**`active_s` is the meter.** T4-D27 and T7's PlayCap finding both land here: an idle Spotify window
left open overnight must not burn an hour of a budget. `usage_daily.active_s` is therefore *already*
the number a D.4 budget would be enforced against, computed and stored from day one, before anyone
decides whether to build budgets.

**If D.1 goes to the rich tier** (Screen Recording for window titles, per-browser Automation for
URLs), the shape does not change: two nullable columns on `usage_hourly` and one extra key in the
raw `data` JSONB. **[ARITH]** A ~60-byte title pushes the raw row from ~268 to ~330 bytes, about
+23 % — immaterial. **What does change is the ethics of retention:** a bundle ID is "she used
Safari"; a window title is "she read *this*". Those deserve different ladders. Recommendation if that
tier is ever enabled: **null out `title` and `url` at 30 days while keeping the counters for 400** —
one `UPDATE` in the nightly job, and the reports degrade from "what she read" to "how long she
browsed", which is the right long-term summary anyway.

### 3.4 `agent_status` — where I am correcting T4

T4 §9.3 says the control plane *"evaluates every device once a minute and **writes an `agent_status`
record**"*, and T4-D15 restates it. Read literally as a Postgres row, that is **1,440 rows per device
per day**.

**[ARITH]** At ~120 bytes a row plus its index, that is **173 KB/day · 63 MB/year**. Held for 400
days like every other health artefact, it becomes **~69 MB — on its own, larger than the entire
steady-state raw telemetry store (≈68 MB) and ~16× the size of every rollup combined (≈4.2 MB)**.
It would be the biggest table in the database. To record a value that changes about **eight times a
day** — asleep at bedtime, awake in the morning, and the occasional degradation.

**But the row was never the point.** Read T6, which owns this design: the requirement is that
*alerting keys off a **presence** rather than an absence*, because a LogQL query matching nothing
returns *no series*, Grafana evaluates that as **No Data**, and the synthetic `DatasourceNoData`
alert *"may not inherit existing silences or notification policies"* **[T6 §2.6]**. T6's own alert
rules read `{app="…", component="control-plane"} | json | event="agent_status"` — **that is a log
line in Loki, not a database row.**

So:

> **The once-a-minute evaluation emits a pino line** (`log.info({ event: "agent_status", … })`,
> stdout → the existing Alloy DaemonSet → Loki), exactly as T6's alert rules assume.
> **Postgres stores intervals** — one row per *state change* — plus the current state denormalised
> onto `devices`.

Nothing in T6's alerting changes; every one of its five LogQL rules works unmodified. What changes is
that the database stores ~8 rows a day instead of 1,440, and the "7-day state timeline" panel — the
one T6 says *"earns its place"* — reads a handful of interval rows instead of aggregating ten
thousand samples.

⚠️ **One thing to check on day one, because it will otherwise waste an hour:** T6's queries use the
stream labels `{app=…, component=…}`, but the house chart labels pods
`app.kubernetes.io/name` / `app.kubernetes.io/component` **[homecal]**. Whether those arrive in Loki
as `app`/`component` depends on the relabel rules in `arch-infra`'s
`platform/observability/alloy/values.yaml`, which I did not read. Verify the actual label names
before writing the alert rules.

### 3.5 The retention ladder

| Tier | Contents | Retention | Why this number |
|---|---|---|---|
| `events` where `class = 'sample'` | per-minute session + app samples, raw JSONB | **90 days** | 3× the agent's ~29-day queue (§3.2's invariant) and a full school term of re-projection headroom if a projection bug surfaces |
| `events` where `class = 'audit'` | enforcement, warnings, policy transitions, clock steps, start/stop, evictions, override redemptions | **400 days** | A school year plus a month. 3.6 MB. There is no reason to be stingy |
| `usage_hourly` | per-app hourly counters | **400 days** | "Show me last October" stays answerable at full grain |
| `usage_daily` | per-app daily counters | **forever** | 0.6 MB/year |
| `session_spans` | awake/active spans | **forever** | 0.8 MB/year |
| `enforcement_log` | the projected audit trail | **forever** | 3.2 MB/year. **This is the product** |
| `policy_versions` | signed documents + JWS | **forever** | The audit trail and the undo. 0.8 MB/year |
| `agent_status_intervals` | health state history | **400 days** | 0.5 MB/year |
| agent log lines in Loki | free-text operational logs | **Loki's own retention** | Not our storage, and deliberately not authoritative (T4-D22) |

**Pruning is a `DELETE … WHERE received_at < now() - interval`, in the nightly in-process job, with a
BRIN index carrying the scan. No partitioning.** At ~730 k rows a year, declarative partitioning
would buy a `DROP TABLE` instead of a `DELETE` and cost real Drizzle friction (partitioned tables
need hand-written SQL in migrations). Documented upgrade trigger: **revisit if `events` ever exceeds
~50 M rows**, which at this rate is roughly the year 2094.

**Two honesty rules the ladder must not break:**

1. **A pruned window must still be visibly pruned.** Reports read rollups, which outlive raw, so
   pruning raw removes detail and never removes the fact that time passed.
2. **Gaps are data.** T4's `queue.evicted` synthetic audit event records `{dropped_count, oldest_ts,
   newest_ts, reason}` whenever the agent's queue wraps **[T4 §7.2]**, and the projector writes it
   into `enforcement_log` as a first-class row. *"A report that silently omits four days because the
   queue wrapped is worse than no report."* The same applies to `SILENT_TOO_LONG` intervals — the
   reporting layer must render them as a marked gap, not as zero usage. **Zero usage and no data look
   identical on a bar chart and mean opposite things.**

### 3.6 Storage — actual numbers

**[ARITH] Assumptions, all stated so you can redo this:**

- One child, one Mac, 60-second tick, agent 1.x, free telemetry tier (bundle ID + CPU + idle + power).
- Mac powered on **14 h/day** average (≈ 07:00–21:30 school nights, a little less at weekends) = 840 min/day.
- `session.state`: 1 per minute of uptime = **840/day**.
- `app.usage_sample`: ~1.4 per minute (mostly one frontmost app; occasionally 2–3 in a minute with app switching) = **≈ 1,180/day**.
- `class: "audit"`: 3 warnings + 1 lock + boundary transitions + start/stop + the occasional clock/policy event = **≈ 25/day**.
- **Total ≈ 2,045 events/day. Round to 2,000.** (T4's own estimate was ~1,700/day at ~250 bytes — same order, slightly more conservative.)

**Row cost, `events`, with `uuid` keys and house column types:**

| Component | Bytes |
|---|---|
| tuple header + line pointer | 28 |
| `household_id`, `device_id`, `event_id` (3 × `uuid`) | 48 |
| `type` `text` (`"app.usage_sample"`, aligned) | 20 |
| `v` `smallint` + `class` `text` | 9 |
| `ts` + `received_at` (2 × `timestamptz`) | 16 |
| `boot_id` `text` | 28 |
| `seq` `bigint` | 8 |
| `data` `jsonb` (avg of the two hot shapes) | 105 |
| alignment slop | ~6 |
| **heap subtotal** | **≈ 268** |
| `UNIQUE (device_id, event_id)` btree entry @ 90 % fill | ≈ 50 |
| `(device_id, ts)` btree entry | ≈ 41 |
| `BRIN (received_at)` | ≈ 0 |
| **total per event** | **≈ 360 bytes** |

**Headline numbers:**

| Measure | Value |
|---|---|
| Raw ingest | **720 KB/day · ≈ 22 MB/month · ≈ 263 MB/year if never pruned** |
| Raw at steady state (90-day sample ladder + 400-day audit) | **≈ 68 MB** |
| Rolled up — everything a report reads | **≈ 11.6 KB/day · ≈ 0.35 MB/month · ≈ 4.2 MB/year** |
| **Compression achieved by the rollup** | **≈ 62×** |
| **Total database, steady state after year 1** | **≈ 79 MB** |
| **Total database after 5 years** | **≈ 101 MB** (the "forever" tables add ~5.4 MB/year) |
| Per additional Mac | **+ ≈ 68 MB steady** |

**What this means for the chart: nothing.** The house `values.yaml` already provisions
`db.persistence.size: 5Gi` on `local-path` **[homecal]**. Four Macs for five years is ~400 MB; with
Postgres bloat, WAL and a `pg_dump` sitting alongside, call it 1.5 GB worst case. **The stock 5Gi is
right. Do not change it.** Postgres itself will hold the entire working set in shared buffers, which
is why §3.5 does not partition and does not need to.

**The one number that would have been wrong:** had `agent_status` gone in as a row per device per
minute (§3.4), it alone would have been **63 MB/year** — the largest table in the database, and
roughly a **doubling** of the five-year total — to store a value that changes eight times a day.
The interval form costs **~0.5 MB/year**, a 130× reduction, and T6's alerting is untouched because
its rules read a Loki stream, not a table.

### 3.7 The schema — `apps/api/src/db/schema.ts` (telemetry half)

```ts
// ═════════════════════════════════════════════════════════════════════════════
// RAW LANDING ZONE — T4 R8, "store first, interpret later".
// The transport knows the envelope. It knows NOTHING about `data`.
// ═════════════════════════════════════════════════════════════════════════════

export const events = pgTable(
  "events",
  {
    // No surrogate PK — (device_id, event_id) IS the key. A bigserial here
    // would be 8 bytes/row and an index nobody reads.
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    // ⚠️ Normalised on ingest. T4 says UUIDv7 in R8 but shows 26-char Crockford
    //    ULIDs in its examples — the same 128 bits, two spellings. If both
    //    reach this column the idempotency key silently stops working and
    //    reports double-count with no error. See §3.1 and conflict X5.
    eventId: uuid().notNull(),

    type: text().notNull(),          // NEVER rejected when unknown (T4 R8)
    v: smallint().notNull().default(1),
    class: text().notNull(),         // 'sample' | 'audit'
    ts: timestamp({ withTimezone: true }).notNull(),        // agent clock: ADVISORY
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(), // authoritative
    bootId: text().notNull(),        // agent-generated, opaque to us → text
    seq: integer().notNull(),        // (bootId, seq) is the true ordering
    data: jsonb().notNull(),
  },
  (t) => [
    // Idempotency. T4-D8: per-EVENT, not per-request, so partial batch
    // acceptance is expressible.
    unique("events_device_event_unique").on(t.deviceId, t.eventId),
    // The projector's bucket recompute + psql archaeology.
    index("events_device_ts_idx").on(t.deviceId, t.ts),
    // Retention prune. A few KB; turns the nightly DELETE into a block-range scan.
    index("events_received_at_brin_idx").using("brin", t.receivedAt),
  ],
);

// Watermark per projection. Keyed on received_at (server clock), NEVER on ts —
// a child stepping the local clock backwards must not be able to push her own
// events permanently behind the watermark (§3.2).
export const projectionState = pgTable("projection_state", {
  name: text().primaryKey(),         // 'usage_hourly' | 'sessions' | 'enforcement'
  watermarkReceivedAt: timestamp({ withTimezone: true }).notNull()
    .default(sql`'epoch'::timestamptz`),
  lastRunAt: timestamp({ withTimezone: true }),
  lastRunRows: integer().notNull().default(0),
  lastError: text(),
});

// ═════════════════════════════════════════════════════════════════════════════
// ROLLUPS — what every report reads. Recomputed whole, never incremented.
// ═════════════════════════════════════════════════════════════════════════════

export const usageHourly = pgTable(
  "usage_hourly",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
    bucketStart: timestamp({ withTimezone: true }).notNull(),  // UTC hour boundary
    bundleId: text().notNull(),                                // "com.apple.Safari"

    foregroundS: integer().notNull().default(0),
    // ★ T4-D27 / T7 PlayCap: the meter. Only one app is frontmost at a time,
    //   so per-app active_s are DISJOINT and SUM() over a day is correct, not
    //   an over-count. This looks wrong at a glance; do not "fix" it.
    activeS: integer().notNull().default(0),
    cpuPctAvg: integer().notNull().default(0),   // ×100, stored as basis points
    sampleCount: smallint().notNull().default(0),

    // Populated only if D.1 ever goes past the free tier. Nulled at 30 days by
    // the nightly job while the counters above keep their 400 (§3.3).
    topTitle: text(),
    topUrlHost: text(),

    projectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("usage_hourly_device_bucket_bundle_unique")
      .on(t.deviceId, t.bucketStart, t.bundleId),
    index("usage_hourly_child_bucket_idx").on(t.childId, t.bucketStart),
  ],
);

export const usageDaily = pgTable(
  "usage_daily",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
    // ★ LOCAL day in policy.timezone, NOT date_trunc('day', ts) in UTC.
    //   Get this wrong and Sunday evening shows up on Monday — the first
    //   thing a parent notices and the last thing anyone thinks to check.
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
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
    // awake | active | locked | asleep
    kind: text().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    endedAt: timestamp({ withTimezone: true }),   // NULL = still open
    bootId: text(),
    consoleUser: text(),
    // TRUE when the span's end was inferred from silence rather than observed.
    // Renders as a dashed edge in the UI — an honest "we don't actually know".
    endInferred: boolean().notNull().default(false),
  },
  (t) => [
    index("session_spans_device_started_at_idx").on(t.deviceId, t.startedAt),
    unique("session_spans_device_kind_started_unique").on(t.deviceId, t.kind, t.startedAt),
  ],
);

// The projected audit trail. THIS IS THE PRODUCT — what a parent means when
// they ask "but what actually happened?". Kept forever; it is 3 MB a year.
export const enforcementLog = pgTable(
  "enforcement_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    childId: uuid().notNull().references(() => children.id, { onDelete: "cascade" }),
    eventId: uuid().notNull(),         // back-reference into events; survives its pruning
    // warning_shown | action_taken | action_failed | policy_applied |
    // policy_rejected | degraded | clock_stepped | override_redeemed |
    // override_expired | queue_evicted | agent_started | agent_stopping
    kind: text().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    windowId: uuid().references(() => scheduleWindows.id, { onDelete: "set null" }),
    policyVersion: integer(),
    // The one denormalised, human-readable line the report renders. Composed at
    // projection time so a schema change to `detail` cannot break old history.
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

// T6's five-state machine, stored as INTERVALS — see §3.4. The once-a-minute
// evaluation emits a pino LOG LINE (which is what T6's LogQL rules read); this
// table only records transitions. ~8 rows/day instead of 1,440.
export const agentStatusIntervals = pgTable(
  "agent_status_intervals",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    // HEALTHY | DEGRADED | EXPECTED_OFFLINE | UNEXPECTED_SILENCE | SILENT_TOO_LONG
    state: text().notNull(),
    // policy_missing | policy_corrupt | signature_invalid | enforcement_failed |
    // clock_untrusted | disk_full | enforcer_heartbeat_missing | …
    reason: text(),
    enteredAt: timestamp({ withTimezone: true }).notNull(),
    exitedAt: timestamp({ withTimezone: true }),
    // T4's addition on top of T6: enter UNEXPECTED_SILENCE at 10 min, but do
    // not buzz a phone until 60 — a macOS update restart routinely exceeds 10.
    notifiedAt: timestamp({ withTimezone: true }),
    // T4 §9.7 retrospective reclassification: if system_boot_time lands inside
    // the silence window the Mac was simply off, and the interval is rewritten
    // to EXPECTED_OFFLINE after the fact. No network probe, ever (T4-D21).
    reclassifiedFrom: text(),
  },
  (t) => [
    index("agent_status_intervals_device_entered_at_idx").on(t.deviceId, t.enteredAt),
  ],
);

// T4 §6.8 — cheap non-boundary signals. Surfaced as ONE banner, not eight
// alerts, and under AR.1 deliberately never as a notification: the value is
// that the history exists when someone later asks "has she ever tried?".
export const tripwires = pgTable(
  "tripwires",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    // hardware_uuid_mismatch | unexpected_source_ip | concurrent_boot_ids |
    // signature_invalid | policy_version_regression | network_time_disabled |
    // timezone_mismatch | agent_stopped_while_up | override_unmatched |
    // kill_switch_present
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

// ═════════════════════════════════════════════════════════════════════════════
// D.2 SUPPORT — one query service, four sinks, no commitment. See §6.7.
// Both tables are tiny and exist on day one so that "turn on the weekly email"
// is a config flag rather than a migration.
// ═════════════════════════════════════════════════════════════════════════════

export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    deviceId: uuid().references(() => devices.id, { onDelete: "cascade" }),
    // health_degraded | silent_too_long | tripwire | override_unmatched |
    // enforcement_failed | policy_rejected
    kind: text().notNull(),
    severity: text().notNull().default("info"),  // info | warning | critical
    title: text().notNull(),
    body: text().notNull(),
    dedupeKey: text().notNull(),                 // suppresses the same fact re-firing
    firstFiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastFiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp({ withTimezone: true }),
    deliveryChannel: text(),                     // ui | email | webhook | grafana
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
    householdId: uuid().notNull().references(() => households.id, { onDelete: "cascade" }),
    childId: uuid().references(() => children.id, { onDelete: "cascade" }),
    period: text().notNull(),                    // daily | weekly | monthly
    periodStart: date().notNull(),
    periodEnd: date().notNull(),
    // The EXACT output of reportQuery(). Rendering a stored digest must never
    // re-run the query — otherwise last week's email and last week's archived
    // page disagree after a projector fix, which is worse than either.
    payload: jsonb().notNull(),
    generatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp({ withTimezone: true }),
    deliveryChannel: text(),
  },
  (t) => [
    unique("digests_household_child_period_unique")
      .on(t.householdId, t.childId, t.period, t.periodStart),
  ],
);

// ═════════════════════════════════════════════════════════════════════════════
// Relations — house convention: one trailing block, after every table.
// (Abbreviated; the pattern repeats for each FK above.)
// ═════════════════════════════════════════════════════════════════════════════

export const householdsRelations = relations(households, ({ many, one }) => ({
  members: many(householdMembers),
  children: many(children),
  devices: many(devices),
  serviceUser: one(users, {
    fields: [households.serviceUserId], references: [users.id],
  }),
}));

export const childrenRelations = relations(children, ({ one, many }) => ({
  household: one(households, {
    fields: [children.householdId], references: [households.id],
  }),
  policySets: many(policySets),
  devices: many(devices),
  overrides: many(overrides),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  household: one(households, {
    fields: [devices.householdId], references: [households.id],
  }),
  child: one(children, { fields: [devices.childId], references: [children.id] }),
  policySet: one(policySets, {
    fields: [devices.policySetId], references: [policySets.id],
  }),
  apiKey: one(apikeys, { fields: [devices.apiKeyId], references: [apikeys.id] }),
  policyVersions: many(policyVersions),
  enrollments: many(enrollments),
  desiredItems: many(desiredItems),
  statusIntervals: many(agentStatusIntervals),
  tripwires: many(tripwires),
}));

export const policySetsRelations = relations(policySets, ({ one, many }) => ({
  child: one(children, { fields: [policySets.childId], references: [children.id] }),
  windows: many(scheduleWindows),
  budgets: many(scheduleBudgets),
  expectedOnline: many(expectedOnlineWindows),
  devices: many(devices),
}));

export const scheduleWindowsRelations = relations(scheduleWindows, ({ one, many }) => ({
  policySet: one(policySets, {
    fields: [scheduleWindows.policySetId], references: [policySets.id],
  }),
  warnings: many(scheduleWarnings),
  overrides: many(overrides),
}));

export const overridesRelations = relations(overrides, ({ one }) => ({
  child: one(children, { fields: [overrides.childId], references: [children.id] }),
  device: one(devices, { fields: [overrides.deviceId], references: [devices.id] }),
  window: one(scheduleWindows, {
    fields: [overrides.windowId], references: [scheduleWindows.id],
  }),
  grantedByUser: one(users, { fields: [overrides.grantedBy], references: [users.id] }),
  sourceException: one(calendarExceptions, {
    fields: [overrides.sourceExceptionId], references: [calendarExceptions.id],
  }),
}));
```

---

## 4. T5.3 — Deltas against the `home*` template

### 4.0 Which sibling is the template?

⚠️ **There are two generations and picking the wrong parent will cost you a schema rewrite. [homecal]**

| | `homecal` | `homework` (newest, 2026-05-30 scaffold) |
|---|---|---|
| Auth | ✅ better-auth, `admin()` + `bearer()` + `apiKey()` | ❌ none |
| Drizzle `casing` | unset → **camelCase quoted columns** | **`snake_case`** |
| Zod | **4** (`z.iso.datetime()`) | 3 (`z.string().datetime()`) |
| Config | inline `process.env.X ?? default` | `src/config.ts` frozen literal |
| App factory | module-level `export const app` | `export function createApp()` |
| Knowledge capture | — | `knowledge/`, `docs/adr/`, `.devkit/` |

**Recommendation: take `homework`'s newer conventions** (`casing: "snake_case"`, `src/config.ts`,
`createApp()`, `knowledge/`, `closeDb()`) **and `homecal`'s auth wholesale**, because `homecal` is the
only sibling that has any. The one seam this creates — better-auth's drizzle adapter has never been
run against `casing: "snake_case"` in this house — is a 15-minute day-one check (§2.7).

`homework` describes itself as *"follows the exact house pattern of the sibling projects homenews and
homecal"*, so this is the intended direction of travel, not a fork.

### 4.1 The deltas table

| Component | Stock `home*` | This app | Why different |
|---|---|---|---|
| **Monorepo / pnpm / turbo** | `pnpm@10.29.3`, `turbo@^2.8.10`, `apps/*` + `packages/*`, the six-task `turbo.json` | **As per template**, plus `packages/contract` | T4 **R9**: *"Nothing on this boundary is a database row."* The zod wire schemas are a published package consumed by the API and — via a JSON-Schema artefact emitted in CI — by the **Swift** agent. Keeping them in `apps/api` is how "the payload evolves later" quietly becomes "every payload change is a migration" |
| **Hono API** | `hono@^4.11.9`, `@hono/node-server`, dual-mount `/api` + `/api/v1` | **Single mount. `/api/parent/v1/*` and `/api/agent/v1/*`** | T4 fixes the agent paths at `/api/agent/v1/…`. The dual `/api` + `/api/v1` mount exists in `homecal` only to carry a legacy client through a `Sunset` header — a greenfield app inherits the debt for nothing |
| **better-auth (parent)** | `admin()`, `bearer()`, `apiKey()`, `emailAndPassword`, 7-day sessions, `generateId: false`, `usePlural: true`, the `COOKIE_DOMAIN` conditional spread | **As per template, copied verbatim** | The cookie-domain spread and `generateId: false` are both scar tissue; copy them without editing |
| **better-auth (agent)** | `apiKey({ apiKeyHeaders: "x-api-key", defaultPrefix: "hc_" })` | **`defaultPrefix: "hpc_dk_"`, plus a hand-rolled `requireAgent` middleware that pulls the token out of `Authorization: Bearer` and calls `auth.api.verifyApiKey()`** | T4 fixes the header as `Authorization: Bearer hpc_dk_…`. The plugin's header getter does not strip a `Bearer ` prefix, so reading it ourselves is cleaner than fighting `customAPIKeyGetter` |
| **API-key rate limiting** | `rateLimit: { enabled: false }` — with a comment recording that the plugin's 10-req/24h default bricked the Kindle display **and surfaced as 401, not 429** | **`rateLimit: { enabled: false }`, and a lint-level "never turn this on"** | ⚠️ **See conflict X2. This is the single most dangerous line in the whole build.** The agent makes 1,440 sync requests a day. T4 §6.4 *recommends* using the plugin's per-key rate limiting as a feature — and T4 §4.7 maps 401 to `halt_sync_keep_enforcing`. Enabling it would stop the agent syncing after ten minutes, permanently, while it reported as *"credential revoked"*. `homecal` already has this scar |
| **Hono rate limiter** | `hono-rate-limiter`, applied to all `/api/*` | **Carve `/api/agent/sync` and `/api/agent/events` OUT. Apply a hard limiter to `/api/agent/v1/enroll` only** (5/min/IP, 20/h global, per T4 §4.3) | Same landmine one layer up: the stock `apiRateLimiter` over `/api/*` would throttle a legitimate 1/minute agent. The only agent endpoint that *needs* a limiter is the unauthenticated one |
| **Device credential ownership** | n/a | **One `isService: true` user per household, owning every device API key** | ⚠️ `apikeys.userId` is `NOT NULL … ON DELETE CASCADE` **[homecal]**. Hanging a device credential off the human who happened to click "Add device" means deleting that parent **silently revokes every device in the house**. `homecal` already ships `users.isService` for exactly this |
| **Drizzle** | `drizzle-orm@^0.45.1` + `postgres-js` (**not `pg`**), single `src/db/schema.ts`, `uuid` PKs, `timestamp({withTimezone:true})`, no `pgEnum`, array-form table extras | **As per template**, plus **`casing: "snake_case"`** and **one `check()` constraint** on `schedule_windows.action` | The check is T4-D26 made structural (§2.6). `casing` follows `homework` |
| **Migrations** | `drizzle-kit generate` → `drizzle/NNNN_*.sql` + `meta/`, baked into the API image, run by the Helm `pre-install,pre-upgrade` hook Job | **As per template, unchanged** | `hook-weight: "-5"`, `hook-delete-policy: before-hook-creation,hook-succeeded`, `backoffLimit: 2`, `ttlSecondsAfterFinished: 600`, `pnpm --filter … exec drizzle-kit migrate` — copy it byte for byte. Also honour `CLAUDE.md`'s **"additive-only, never `drizzle-kit push`"** policy |
| **Zod validation** | Manual `safeParse` at the top of each handler; **no `@hono/zod-validator`** | **As per template on the parent side.** On the agent side, schemas come from `packages/contract` and **`.strict()` is banned by lint** | T4 **R1**: tolerant readers in both directions. `.strict()` is the single thing that breaks forward compatibility |
| **Error shape** | Flat `{ error, details? }`; **no `app.onError` anywhere** | **Parent routes: as per template.** **Agent routes: RFC 9457 `application/problem+json` with the `hpc_action` extension**, via an `onError` scoped to the agent sub-app | T4 §4.7 makes `hpc_action` the machine-readable contract that decides whether the agent backs off, re-enrols, halts sync, or decommissions. It is not decoration |
| **pino** | `base: {service, version}`, `event` for categories, **`latency_ms` not `duration_ms`**, stdout only, Alloy DaemonSet tails it | **As per template**, plus a **`redact` list**: `hpc_dk_*`, the `K_ovr` secret, enrolment codes, `Authorization` | T4 §6.7 and T8 §4.3 both require it, and `biome`'s `noSecrets: "error"` will not catch a runtime log line |
| **Scheduler** | `startReminderScheduler()` / `startDigestScheduler()` — in-process `setInterval`, with `replicaCount: 1` + **`strategy: Recreate`** and a comment explaining that two pods would double-fire | **As per template.** Three schedulers: liveness (60 s), projection (5 min), nightly (retention + digest) | **The house already solved my open question.** No CronJob, no leader election — `Recreate` guarantees no overlap. ⚠️ If `replicaCount` ever exceeds 1, the liveness job must take a `pg_try_advisory_lock` first |
| **Policy signing** | n/a | **Ed25519 JWS (`alg: EdDSA`) over the compiled document; key in `homeparentcontrol-secrets` as `POLICY_SIGNING_KEY`** | T4-D5. New, but small — Node's `crypto` does Ed25519 natively; no library |
| **Telemetry ingest** | n/a | `POST /api/agent/v1/events`, batched, `ON CONFLICT DO NOTHING` | Entirely new. §3.1 |
| **Liveness state machine** | n/a | Five states, once a minute, **log line to Loki + interval row in Postgres** | T6's design, with §3.4's storage correction |
| **Device enrolment** | n/a | `enrollments` table, single-use code, conditional-UPDATE consume | Entirely new. §5 |
| **Offline override card** | n/a | **Static HTML with `K_ovr` embedded, generated per device, served as a download with `Cache-Control: no-store`** | ⚠️ **The most unusual thing in the build.** It cannot be a Next.js page and it cannot be a build artefact — the secret is per-device and minted at runtime, and the whole point is that it works when the cluster is off. T8 §3.6 |
| **`date-holidays`** | `services/holidays.ts` — per-country instance cache, `type === "public"` filter, 100-entry FIFO result cache, **no table, no job** | **Reuse the service file as-is**; call it from the policy compiler | §2.4. My first instinct — a nightly sync into a mirror table — was wrong and the house is right |
| **Next.js web** | `next@^15.3.3`, React 19, App Router, `output: "standalone"`, shadcn `new-york`/`neutral`/lucide, Tailwind v4, `radix-ui` unified, `use-<thing>.ts` hooks with `{data, isLoading, error, refetch}`, relative `/api/*` via `next.config.ts` rewrite, `authClient` hitting `NEXT_PUBLIC_AUTH_URL` directly | **As per template**, page inventory in §6 | Nothing about a parent dashboard is novel. **This is where H4's "80/20 — the control plane is a standard `home*` app" is cashed in** |
| **Helm chart** | api Deployment + web Deployment + db StatefulSet + migrate Job; `_helpers.tpl` `(dict "context" . "component" "X")`; **no ConfigMap and no Secret template**; secrets out-of-band via `create-cluster-secret.sh`; Traefik ingress, **no TLS**, `.arch.internal` | **As per template.** Added secret keys: `POLICY_SIGNING_KEY`. Added `api.env` keys: `AGENT_DESIRED_VERSION`, `AGENT_PKG_SHA256`, `RAW_SAMPLE_RETENTION_DAYS` | ⚠️ **The no-TLS part is conflict X4** — T4's auth reasoning explicitly assumes TLS and the house runs plain HTTP on the LAN |
| **PVC size** | `db.persistence.size: 5Gi`, `storageClass: local-path` | **Unchanged** | §3.6 — 4 Macs × 5 years ≈ 400 MB. The stock size is already right |
| **`.github/workflows/build.yml`** | `test` → `build-and-deploy` (matrix api/web → GHCR `:latest` + `:${{github.sha}}`) → `bump-arch-infra` (`git clone` over `x-access-token` PAT, `yq -i` on `apps/<name>.yaml`, commit, push) | **As per template**, plus a **fourth job `bump-agent-version`, triggered only on `v*` tags** | §4.3. Container images move on every `main` push; the **agent** moves only on a deliberate tag |
| **arch-infra** | `apps/<name>.yaml` Argo CD Application; image SHA lives in `spec.source.helm.parameters`; `migrate.enabled: "true"` set there, `false` in the chart | **As per template**, plus a third parameter: `api.env.AGENT_DESIRED_VERSION` | §4.3 |
| **Biome / tsconfig / Dockerfiles / `.claude/`** | Biome 2.4, kebab-case filenames, lineWidth 100, `.js` import extensions, single-stage API image running `tsx`, two-stage web image, `.claude/{hooks,skills,rules,agents}` | **As per template, all of it** | P3.1/P3.4. ⚠️ One watch-out: `noSecrets: "error"` will flag an Ed25519 test key in a fixture — put test keys behind `process.env` or an override, not an inline literal |
| **Health endpoint** | `GET /health` → `{status:"ok"}`, no DB ping, used for both probes | **As per template**, plus T4's `GET /api/agent/v1/health` returning `{status, contract_versions, server_time}` | T4 §4.5: the agent needs to tell *"the network is down"* from *"the API is up and rejecting me"*, which changes what it logs and what the parent is told |
| **Testing** | vitest, `tests/<domain>/`, three tiers by filename, `fileParallelism: false`, `app.request()` | **As per template**, plus a **golden-file suite for the policy compiler** | The compiler is a pure function (§2.8), so it is the one thing here that is genuinely cheap to pin down — and T3 §5.1 records that POC 1's two bugs were both on the enforcement path and the dry-run suite caught neither |
| **Env validation / global error handler / `/ready`** | none of the three exist | **Add config-at-boot validation** (`homework`'s `src/config.ts` + `process.exit(1)`), **agent-scoped `onError` only** | These are genuine additions, not template gaps. Do not add a global `onError` — it would swallow the parent routes' existing hand-mapped errors |

### 4.2 Three deltas that are more than table rows

**(a) Two auth contexts in one Hono app.** Parent routes take a better-auth **session cookie**;
agent routes take a **bearer API key**. They need separate middleware, separate error shapes and
separate rate-limit policy. The clean split is two sub-apps mounted under `/api/parent/v1` and
`/api/agent/v1`, each with its own `.use()` stack, both composed in `createApp()`. The scope on the
device key is the actual security control **[T4 §6.4]** — `permissions: { device: ["sync",
"policy:read", "events:write"] }` and `metadata: { device_id, hardware_uuid, agent_version }`,
stored by better-auth as **JSON strings**, not `jsonb` **[homecal]**. Every agent handler must
re-check that the key's `metadata.device_id` matches the `device_id` in the body. *"Stolen, the
credential can only read its own bedtime and post its own telemetry."*

**(b) The service user.** One `users` row per household with `isService: true`, created in the same
transaction as the household. It owns every device API key. It has no password and no session, so it
is not a login. This exists solely because `apikeys.userId` is `NOT NULL ON DELETE CASCADE`
**[homecal]** — and the failure it prevents (*"I removed my ex-partner's account and every Mac went
offline"*) is the kind that is obvious in hindsight and invisible in review.

**(c) The offline card is not a web page.** `GET /api/parent/v1/devices/:id/override-card` returns a
self-contained `text/html` document with `K_ovr` inlined, `Content-Disposition: attachment`,
`Cache-Control: no-store`, and no external references of any kind. It computes HOTP codes in the
browser with `crypto.subtle.importKey`/`sign` **[T8 §3.6]**. The parent saves it to their home
screen **once, while the server is up**. If it is served as an ordinary route and the parent
bookmarks the URL, the feature is worthless in exactly the scenario it exists for — which is a
mistake that is invisible until the night it matters.

### 4.3 The agent's version pin in GitOps (T3)

T3 asked for *"a version pinned in the existing GitOps repo — so Argo CD reconciles the agent version
exactly as it reconciles a container tag, and `git revert` is the rollback"* **[T3 §4.3]**. The house
mechanism already does this with zero new files.

`arch-infra`'s `apps/homecal.yaml` carries the image SHA in `spec.source.helm.parameters`, and the
chart's `deployment-api.yaml` already does `range $k, $v := .Values.api.env` **[homecal]**. So:

```yaml
# arch-infra/apps/homeparentcontrol.yaml
      parameters:
        - name: api.image.tag
          value: "<sha>"               # bumped by CI on every main push
        - name: web.image.tag
          value: "<sha>"               # bumped by CI on every main push
        - name: migrate.enabled
          value: "true"
        - name: api.env.AGENT_DESIRED_VERSION
          value: "1.4.2"               # ← bumped ONLY on a v* tag
        - name: api.env.AGENT_PKG_SHA256
          value: "9f2c…"               # the supervisor verifies this itself (T3 §1.1)
```

**No chart template changes at all** — `helm --set api.env.AGENT_DESIRED_VERSION=…` writes into the
existing map. The API reads it from the environment and publishes it as a
**`desired[]` item of `kind: "agent_version"`**, converged when the device reports a matching
`device.agent_version` on a tick.

**That last move is the important one.** T3 specified a bespoke endpoint,
`GET /api/v1/agent/desired` **[T3 §4.3]**. T4 then **deleted the command channel entirely** and
replaced it with `desired[]` reconciliation **[T4-D24]**. Folding the version pin into `desired[]`
means **zero new endpoints**, and it gets T4's reconciliation properties for free: idempotent by
`desired_id`, re-sent every tick until converged, self-healing on a dropped response, and
`status: "unsupported"` if an older agent does not understand it (**R6**). It also completes the
chain T3 wanted — Argo CD reconciles git → cluster, and the same `desired[]` mechanism reconciles
cluster → device.

**Two deliberate asymmetries:**

1. **Containers bump on every `main` push; the agent bumps only on a `v*` tag.** T3's shadow-mode
   soak (§5.4) and attended supervisor upgrades both require agent releases to be deliberate. A
   fourth CI job (`bump-agent-version`, `if: startsWith(github.ref, 'refs/tags/v')`) reuses the
   existing `yq` + PAT pattern against the same file.
2. ⚠️ **`AGENT_PKG_SHA256` is not a nice-to-have.** T3 measured that `installer -pkg` run as root
   **bypasses Gatekeeper** **[T3 §1.1]**, so the supervisor must verify `pkgutil --check-signature`
   plus a pinned digest itself. The control plane's only job is to *publish* the pin honestly — but
   if it publishes a digest nobody checks, it is worse than not publishing one, because it looks
   like a control.

⚠️ **One template trap to know about before relying on any of this. [homecal]** The `bump-arch-infra`
job **soft-skips with `::warning::` and `exit 0`** when `ARCH_INFRA_TOKEN` is unset or
`apps/<name>.yaml` does not exist. **A completely unwired GitOps chain therefore looks like a green
build.** Create the Argo CD Application CR and the PAT secret *before* trusting the pipeline, and
check the first bump landed by hand.

---

## 5. T5.4 — Enrolment and bootstrap

> *"Currently unspecified anywhere."* True — T3 recommends the shape, T4 specifies the credential,
> and nobody joined them up. This section is that join, plus the interruption cases, which are where
> the real work is.

### 5.1 The two halves, reconciled

| | T3 §3.3 | T4 §6.4 / §6.6 | **This design** |
|---|---|---|---|
| Bootstrap | one-time enrolment token at install, 24 h, single use | one-time enrolment **code**, ~60 bits Crockford base32, 15 min, single use | **Code, single use. TTL 60 min — see §5.4 (iv)** |
| Credential | short-lived (30 d) + `POST /rotate` | durable, rotated via `desired[]`, no rotate endpoint | **T4 wins. Durable better-auth API key, rotation as desired state** |
| Storage on disk | `/usr/local/etc/homeparentcontrol/credential.json` | `/var/db/homeparentcontrol/credential.json` | Agent-side; T4's path, for consistency with the rest of its state dir |
| On revocation (401) | *"agent wipes credential.json, **disables enforcement**"* | `halt_sync_keep_enforcing` — **enforcement continues** | ⚠️ **T4 wins, and this is conflict X1b.** T3's version hands the child a bypass |

**The contract is what it is.** T4 is fixed; where T3 disagrees, T4 is the design of record and the
disagreement is recorded in §7 rather than quietly resolved.

### 5.2 The flow, end to end

```
 Parent (browser)              Hono API                        Mac mini (root shell)
 ───────────────               ────────                        ─────────────────────
 Devices → "Add a Mac"
   name it, pick the child,
   pick the policy set
                    ───────▶  BEGIN
                              INSERT devices (status='pending')
                              code = crockford32(60 bits)
                              INSERT enrollments (device_id,
                                code_hash=sha256(code),
                                code_hint='HPC-K7QM',
                                expires_at=now()+60min)
                              COMMIT
                    ◀───────  show the code ONCE, plus a copyable line:

                                sudo hpc-agent enroll \
                                  --server http://hpc-api.arch.internal \
                                  --code HPC-K7QM-3ZTD-9F2W
                                                          ───────▶  (parent types it)
                              ◀──── POST /api/agent/v1/enroll
                                    { enrollment_code, device{hardware_uuid,
                                      hostname, model, os_version,
                                      agent_version}, agent{capabilities[]} }

                              ── ONE TRANSACTION ─────────────────────────────
                              UPDATE enrollments SET consumed_at=now(),
                                     consumed_ip=…, consumed_hardware_uuid=…
                                WHERE code_hash=$1
                                  AND consumed_at IS NULL
                                  AND expires_at > now()
                                RETURNING device_id        ← 0 rows = 409 / 410
                              auth.api.createApiKey({ userId: household.serviceUserId,
                                     prefix:'hpc_dk_', name:'dev:<uuid>',
                                     permissions:{device:['sync','policy:read',
                                                          'events:write']},
                                     metadata:{device_id, hardware_uuid, agent_version} })
                              UPDATE devices SET status='enrolled',
                                     hardware_uuid=…, api_key_id=…
                              compilePolicy(device) → policy_versions v1
                              ────────────────────────────────────────────────
                    ◀───────  201 { device_id, credential{token,key_id,
                                    issued_at, rotate_after},
                                    policy_signing_keys[], base_url }
                                                          write credential.json 0600 root:wheel
                                                          launchctl bootstrap both daemons
                              ◀──── POST /api/agent/v1/sync   (first tick)
                              UPDATE devices SET status='active'
                    ◀───────  device card turns HEALTHY
```

**Design points, each earning its place:**

1. **The single-use guarantee is the conditional `UPDATE`, not a read-then-write.** `WHERE
   consumed_at IS NULL … RETURNING` is atomic under any concurrency, with no advisory lock and no
   serialisable isolation. Two Macs racing the same code: exactly one gets a row back.
2. **The code is hashed at rest.** Only `code_hint` (`"HPC-K7QM"`) is stored in the clear, which is
   enough for the UI to say *which* outstanding code it is showing.
3. **The device row exists before the code does.** This is what makes every recovery path in §5.4
   idempotent — an enrolment *targets an existing device*, so retrying, re-issuing and re-enrolling
   all converge on the same `device_id` and the same telemetry history.
4. **Policy v1 is compiled inside the same transaction.** The agent's very first tick then gets a
   real policy rather than a `404`, which matters because T4's failure class B ("agent running, no
   cached policy at all") is **fail-open, loudly** — an unnecessary trip through `DEGRADED` on the
   first evening is a bad first impression for a system whose entire value is trust.
5. **`status` moves `pending → enrolled → active`.** `enrolled` means "credential issued, never
   seen"; `active` means "it has actually ticked". Collapsing those two loses the ability to
   distinguish "the install failed" from "nobody has run the installer yet".

### 5.3 Rate limiting and the code's own arithmetic

`POST /api/agent/v1/enroll` is the **only unauthenticated write endpoint in the system**, so it gets
`hono-rate-limiter` at **5/min/IP and 20/hour globally** **[T4 §4.3]**, plus a per-enrolment
`attempts` counter that burns the row after 5 failures.

**[ARITH]** ~60 bits of Crockford base32 is 12 characters in three groups. Against 20 guesses/hour
that is on the order of 10¹³ years. The rate limit is there for hygiene, not because the code is
weak — and it must **never** be tightened to a point where a parent fat-fingering a code three times
locks themselves out of adding their own Mac.

### 5.4 What happens when enrolment is interrupted

This is the part that decides whether "add a Mac" is a five-minute job or a phone call, and it is
where most enrolment designs are thin.

| # | Interruption | What the server sees | Behaviour |
|---|---|---|---|
| **(i)** | Agent crashes *after* the server committed, before writing `credential.json` | Code consumed, key issued, never used | The token is gone for good — better-auth stores a hash. **Recovery: the parent issues a new code for the same device.** The handler sees a device that already has an `api_key_id` which was never used, **revokes it**, and issues a fresh one |
| **(ii)** | Response lost in flight; the agent retries the same code | Second request, same `code_hash`, **same `hardware_uuid`**, inside the original TTL, previous key never used | ⚠️ **[INFERENCE — a genuine addition]** **Re-issue, do not 409.** Revoke the unused key, mint a new one, `reissue_count++`, return `201`. This turns the single most likely failure on a flaky LAN from *"go and ask the parent for another code"* into *"the retry just worked"*. Guarded by all four conditions; any one missing → `409` |
| **(iii)** | Two different Macs race one code | Second request has a **different** `hardware_uuid` | `409` + `hpc_action: "reenroll"`. The conditional UPDATE already decided the winner; (ii)'s re-issue path is gated on the hardware UUID matching, so it cannot be abused to clone a device |
| **(iv)** | Code expires before use | `expires_at < now()` | `410 Gone`. ⚠️ **TTL deviation:** T4 §6.6's prose says 15 minutes. **I recommend 60.** The real flow is *generate on a phone → walk to the other room → find Terminal → remember the sudo password*, and 15 minutes turns the very first use of the product into a re-issue loop. The TTL is prose, not contract, so this breaks nothing |
| **(v)** | Enrolment never attempted | `enrollments` row expires; device sits `pending` | The device card shows **"setup never completed"** with a one-click delete. **Do not auto-delete the device row** — a device row may already own telemetry, and orphaning it to tidy up is worse than a stale card |
| **(vi)** | Wrong code typed repeatedly | `attempts` climbs | 5 strikes burns the row; the parent issues another. `401` never appears here — a bad code is a `404`/`400`, so it can never be confused with a revoked credential |

### 5.5 Re-enrolment after a wipe

**The rule: `hardware_uuid` is the physical identity, `devices.id` is the logical identity, and the
logical identity survives a reinstall.** That is what makes *"show me last term"* still work after
the Mac has been wiped — which is exactly what a parent expects and exactly what a naive
"enrolment creates a device" design destroys.

```
Parent → Devices → Lucy's Mac mini → "Re-enrol this Mac"
  → new enrollments row against the SAME device_id
  → agent enrolls
  → server: revoke old api key, issue new, devices.status='enrolled'
  → everything keyed on device_id — every event, rollup, policy version,
    enforcement log row, status interval — is untouched
```

Three cases the handler must separate, and it can, because it has both UUIDs:

| Observed | Reading | Action |
|---|---|---|
| `hardware_uuid` matches the device row | Same Mac, reinstalled | Normal re-enrol. Record `device.re_enrolled` |
| `hardware_uuid` **differs**, code was issued for this device | Logic board swapped, or the parent is moving the "slot" to a new Mac | **Accept, update `hardware_uuid`, and raise a `hardware_uuid_mismatch` tripwire** |
| `hardware_uuid` matches a **different, active** device | A code was typed on the wrong Mac | `409`. This is the one case where guessing would be actively harmful |

**Why accept-and-flag rather than refuse on a hardware change. [INFERENCE]** Under **AR.1** the
overwhelmingly likely explanation is a legitimate repair or reinstall, and refusing would strand the
parent at exactly the moment they are trying to fix something. T4's own posture is that tripwires
exist *"to be found when someone later asks 'has she ever tried?', not to page a parent tonight"*
**[T4 §9.7]**. Accept, record, surface on the health card. If the owner's threat model ever changes,
flipping this to a refusal is one line — and §7 records that it is a choice.

**What re-enrolment does NOT do:** it does not reset the policy, does not clear overrides, does not
zero the counters, and does not issue a new `K_ovr` unless asked. The Mac comes back and the rules
are already there.

### 5.6 Bootstrap, the parts before any device exists

**(a) First-run claim — reuse `homecal`'s own mechanism.** `homecal` already has a
`databaseHooks.user.create.before` that makes the **first** user an admin by counting rows
**[homecal]**. Extend the same hook: if `count(users) === 0`, create the household, create its
`isService` user, add the human as `role: "owner"`, and seed a default `policy_set` with a
school-night and a weekend window. After that, **signup is closed** and further parents arrive by
invite. No `ALLOW_SIGNUP` env var to forget, and no migration-seeded singleton — which would be a
hardcoded identity in a costume (§2.1 rule 4).

**(b) The policy signing keypair.** Ed25519, generated once, private half in
`homeparentcontrol-secrets` as `POLICY_SIGNING_KEY` via the house's out-of-band
`create-cluster-secret.sh` **[homecal]**. The **public** half is handed to the agent in the enrolment
response as `policy_signing_keys[]` **[T4 §4.3]**.

⚠️ **This is trust-on-first-use, and it should be said out loud.** The agent learns which public key
to trust from the enrolment response, over plain HTTP (conflict **X4**), on the LAN. A hostile host
on the LAN at that instant could seat its own signing key. Under **AR.2** (trusted LAN) and **AR.1**
(the child is not an attacker) this is acceptable — and the documented upgrade is one line in the
installer: `--pin-key sha256:…`, compared against the received key before anything is written.
Worth having in the runbook even if it is never used.

**(c) `K_ovr` ships disabled.** `policy_sets.offlineCodesEnabled` defaults to **`false`**, because
T8's entire offline path depends on **V-T8.1** — *"`CFUserNotification` text entry from a root
daemon, never once observed working in this project, and the override path has no fallback
surface"* **[T8 §1.8, C5]**. The online grant path (T8 mechanism **b**) has no such dependency and is
about a day's work. **Ship (b), leave the flag off, flip it when V-T8.1 passes.** The schema, the
key table, the reveal table and the reconciliation job are all here on day one, so flipping it is a
toggle rather than a project.

### 5.7 Decommission — the one path that stops enforcement

`410 Gone` with `hpc_action: "decommission"` is the **sole** way the protocol can stop an agent
enforcing **[T4-D18]**. Server side that means: a parent-initiated action only, never an error
path, never a timeout, never an inferred state; `devices.status = 'decommissioned'`; the API key
revoked; every `desired_items` row for that device dropped; **and all telemetry retained**, because
the child's history is not the device's property.

The UI must make it a typed-confirmation action distinct from **Revoke**, and must say what each one
does, because they look similar and behave oppositely:

> **Revoke** — the Mac stops talking to the server **but keeps enforcing bedtime**. Use this if you
> think the credential leaked.
> **Decommission** — the agent uninstalls itself and **stops enforcing anything**. Use this when the
> Mac is leaving the house.

---

## 6. T5.5 — The parent UI surfaces

Not visual design. What pages exist, what each is for, and what each one must say — because on this
product the *wording* is load-bearing in several places, and those are called out.

House conventions apply throughout: Next.js App Router, shadcn `new-york`/`neutral`/lucide,
Tailwind v4, one `use-<thing>.ts` hook per resource returning `{data, isLoading, error, refetch}`,
relative `/api/*` through the `next.config.ts` rewrite, `authClient.useSession()` guards **[homecal]**.
None of that is worth further words.

### 6.1 `/` — Today

The landing page and the one the parent actually opens. **One card per device** (one today, N later
— the component takes a device, never "the device").

- **Health**, in plain language, mapped from the five states. `EXPECTED_OFFLINE` renders as
  *"Asleep"* in grey, never as an error.
- ⚠️ **The banner wording when the agent is silent**, taken from T4 §8.3 and worth quoting because
  the obvious phrasing is exactly wrong: *"Lucy's Mac hasn't checked in for 2 days — **it is still
  enforcing the rules from Tuesday**."* The natural parental fear on seeing "offline" is *"so the
  rules aren't working"*, which is the opposite of the truth.
- **Tonight's boundary**, with any active override folded in: *"Bedtime 21:30 → 22:00 (+30 min, you,
  6:12 pm)"*.
- **Today's screen time so far**, from `usage_hourly` for the current local day. Top three apps.
- **One tripwire banner, not eight** **[T4 §6.8]**. `tripwires` rows collapse into a single
  *"Something changed on Lucy's Mac"* line that expands.
- **Grant buttons** — 15/30/60 — right here, because this is the page open when the child asks.

### 6.2 `/devices/[id]` — Device detail

**Opening this page sets `devices.attendedUntil = now() + 10 min`**, which is T4's server-side sticky
flag driving `next_poll_after_ms: 5000` — the 5-second `attended` cadence **[T4 §2]**. That is the
whole mechanism by which a grant lands in ~5 seconds with no push channel, and it is triggered by
navigation, not by a button.

Contents: the **7-day state timeline** (T6's one panel that *"earns its place"*, now a cheap read
over `agent_status_intervals`); agent version, OS version, arch, `system_boot_time`; clock posture
(`using_network_time`, skew, `tzdata_version`, system-vs-policy timezone); policy version, ETag and
age; queue depth and last eviction; the full tripwire list with acknowledge; **Away until…**
(`devices.awayUntil` — one control, and the difference between an alert channel the parent trusts
and one they muted after the second school holiday **[T4 §9.6]**); and **Revoke / Re-enrol /
Decommission** with §5.7's wording.

### 6.3 `/rules` — the schedule editor

Windows per child. Day pickers, times, action, warning ladder, `fail_mode`.

**Publishing is explicit: draft → diff → publish.** Editing authoring state does not change what the
Mac does until a `policy_version` is minted (§2.2). The diff view shows the compiled document
change, not the form change, because the compiled document is what the agent obeys.

**The confirmation dialog fires on tightenings only.** T4-D17 requires `confirm_immediate_effect`
for anything biting within 15 minutes, but T8/**C3** correctly notes that applying it to every
change would fire on every +30-minute grant and train the parent to click through the guard *in
exactly the case it was built for* **[T8 §9 C3]**. So:

> **Tightening within 15 minutes → confirm** (*"This will lock Lucy's Mac in 4 minutes. Continue?"*).
> **Relaxing → no dialog.**
> **Revoking a grant early → confirm**, because that tightens.

### 6.4 `/rules/calendar` — exceptions

Month grid. Public holidays from `date-holidays` appear automatically, greyed, each with **Apply /
Dismiss** — because "the bank is shut" and "she has no school" are different facts and the parent
needs one click to say which. Manual add: *"No school tomorrow → +60 min"*, *"Sleepover → no bedtime
Saturday"*. Ranges create N rows.

**Show the 21-day horizon and say what it means:** *"Exceptions are sent to Lucy's Mac 21 days
ahead. If it is offline longer than that, the normal school-night rules apply until it reconnects."*
That is T4-D7's converge-stricter property, stated as a product behaviour rather than left as a
surprise.

### 6.5 `/rules/history` — policy versions

The list of `policy_versions` with who published, why, and a diff between any two. **Restore**
publishes a *new* version with the old content; it never mutates history. This is the `git revert`
gesture the owner already uses for the cluster, applied to bedtime.

### 6.6 `/override` and `/override/card`

**`/override`** — child, device, duration chips (15/30/60), optional reason. The card then shows
T8 §6.2's two-stage state, and the distinction matters:

```
+30 min for Lucy            Sent ✓ 21:29:58  →  Applied ✓ 21:30:03  (5 s)
Bedtime tonight: 21:30 → 22:00 · expires 06:00
```

> ***"Applied" is driven by the agent's own next tick** reporting the new `policy_version` and a
> shifted `next_boundary_at` — never by the server's own write.* **[T8 §6.2]** If it has not landed
> in 30 s the card says `Sent ✓ — not yet applied` plus the device's health. Claiming success on the
> write is the *"the server thinks it delivered"* failure mode that T4 rejected push to avoid.

Two required sentences, both from T8, both easy to omit and both things a parent will otherwise
discover at the worst moment:

- If enforcement has already fired: *"She'll be able to log back in within about 5 seconds. **This
  won't wake the Mac for her.**"* **[T8 §7.2]** — nothing third-party can act over the macOS lock
  screen, and the enforcer simply stops re-locking.
- If the device is offline: *"Lucy's Mac hasn't checked in for 14 minutes. This grant will apply when
  it reconnects. **To give her the time now, read her this code: 481 906.**"* **[T8 §6.2]** — the
  sentence where the online and offline mechanisms become one feature.

**`/override/card`** — generates and **downloads** the offline card (§4.2c), explains *"Add to Home
Screen, once, now, while this is working"*, offers the printed 30-day fallback via a print
stylesheet, and rotates `K_ovr`. Hidden entirely while `offlineCodesEnabled` is false (§5.6c).

### 6.7 `/reports` — and how D.2 stays open

**D.2 (dashboard / digest / alerts / on-demand) is still the owner's call** **[needs.md §3]**, so
the design commits to **one query service and four sinks**:

```
reportQuery({ householdId, childId?, deviceId?, from, to, grain }) → ReportPayload
        │
        ├── dashboard    /reports renders it                              ← built now
        ├── digest       digests.payload stores it, email renders it      ← table exists, off
        ├── alerts       notifications rows, channel adapter              ← table exists, UI only
        └── on-demand    GET /api/parent/v1/reports returns it            ← built now
```

**What this buys:** choosing a delivery mode later is a **config flag and one adapter**, never a
schema migration or a second query implementation that drifts. `homecal` already ships
`services/{digest,digest-scheduler,digest-settings,email}.ts` and a singleton `digest_settings`
table **[homecal]** — so if the owner picks "weekly digest", the pattern is copied, not invented.

**One rule that is not optional:** a stored digest renders from its **stored `payload`**, never by
re-running the query. Otherwise last week's email and last week's archived page disagree after any
projector fix, which is worse than either being wrong on its own.

**The reports themselves:** day / week / month; per-app bar chart (`usage_daily`); a session timeline
(`session_spans`, with inferred ends drawn dashed); and the **enforcement timeline** — warnings
shown, locks, overrides used and by whom, policy changes — from `enforcement_log`. Two honesty
requirements:

- **Render gaps as gaps.** `queue.evicted` rows and `SILENT_TOO_LONG` intervals draw a hatched band,
  not zero. **Zero usage and no data look identical on a bar chart and mean opposite things.**
- **Label what `active_s` is.** *"Active time — minutes she was actually using the Mac, not minutes
  it was switched on."* Otherwise the first question every week is why the numbers are lower than
  expected.

### 6.8 `/settings` and `/setup`

`/settings` — household name, timezone, holiday countries, children, parents (invite), notification
channel, a link out to the Grafana dashboard, and the **retention ladder shown read-only** so the
parent can see what is kept and for how long.

`/setup` — the first-run claim (§5.6a): create the account, name the household and the child, pick a
timezone, accept or edit the default school-night/weekend windows, then straight into "Add a Mac".
Reachable only while `count(users) === 0`.

### 6.9 What is deliberately absent

**No child-facing surface of any kind**: no login, no status page, no "time remaining" widget, no
request button, no notification inbox. **P0.3 and P1.5 (C1).** There is no route to delete later
because there is no route.

**No "disable enforcement" button.** The nearest legal action is a `suspend` override with a
mandatory `expires_at` — *"No bedtime tonight"*, not *"off"*. See §2.6 and conflict **X1**.

---

## 7. Conflicts with prior tracks, stated rather than smoothed

The brief asked for these to be flagged rather than reconciled away, *"as prior tracks did — that has
been valuable."* Six are new to this document; the two marked *(known)* were already on the record.

### ⚠️ X1 — T3's kill switch contradicts T4's central invariant. **Nobody has noticed this.**

T3 §5.6 lists a four-tier emergency override ladder. **Tier 3** is:

> *"Server-side `enforcementEnabled: false` — Works when: Agent polling — ≤ 1 poll"* **[T3 §5.6]**

and T3 §4.3 puts `agent.enforcementEnabled: true` in the GitOps `values.yaml` alongside the version
pin. T4's single most important invariant is:

> *"The wire protocol has no 'stop enforcing' verb. No server response, error code, timeout or
> absence of response can cause the agent to stop enforcing a policy it holds."* **[T4 §0]**

**These cannot both be built.** `enforcementEnabled: false` *is* a stop-enforcing verb, delivered
over the wire, with no expiry.

**Resolution: T4 wins, and the GitOps key is deleted.** T4 is the fixed contract, the invariant is
what makes hard requirement 1 structural rather than aspirational, and — decisively — a boolean with
no expiry is precisely the shape T4-D7 exists to forbid. **The legal expression of the same intent is
a `suspend` override with a mandatory `expires_at`**: *"no bedtime tonight"*, never *"off"*. That
covers every case T3's Tier 3 was reaching for, and it cannot be left on by accident.

T3's Tiers 0, 1, 2 and 4 are all **local** and survive untouched — including the `DISABLE` file,
which T8/C2 already corrected the rationale for.

### ⚠️ X1b — T3 and T4 give **opposite** answers to "what happens on revocation". Also unnoticed.

| | Behaviour on `401` |
|---|---|
| **T3 §3.3** | *"Parent UI marks the device revoked → next poll returns 401 → agent wipes `credential.json`, **disables enforcement** (fail-open), and waits for re-enrolment."* |
| **T4 §4.7** | `401` → `hpc_action: "halt_sync_keep_enforcing"` → *"**continues**"*. Matrix row 11: *"✅ **Yes** — keeps enforcing cached policy."* |

This is a direct behavioural contradiction on a safety-critical path, and T3's version has a bad
consequence it does not acknowledge: **it makes credential revocation a bypass.** Anything that gets
the credential revoked — including the child, if she ever works out that a mangled `credential.json`
produces 401s — stops enforcement entirely.

**Resolution: T4 wins, unambiguously.** A revoked device is an *administrative* state, orthogonal to
health (T4-D23) and orthogonal to enforcement. T3's stated worry — *"revoking must never leave a
child locked out by a machine that can no longer be told to stop"* — is real but is answered by
**Decommission** (§5.7), which is a deliberate, authenticated, parent-initiated action, not by
overloading an error code.

### ⚠️ X1c — `poc2-findings.md` records a convergence that is only partial.

POC 2 §5 presents O.1 as *"SETTLED by independent convergence, T3 + T4"*. They converged on the
headline. **They did not converge on staleness, and the findings document smooths that over.**

| | Policy stale beyond its TTL |
|---|---|
| **T3 §5.3** | *"Server unreachable, agent unhealthy, **policy stale beyond its TTL**, credential revoked, clock unsynchronised ⇒ **do not enforce**, and alert."* |
| **T4 §8.3** | *"'After N days, stop enforcing.' ❌ This is a remotely-triggerable bypass. Unplug the ethernet cable for three days and bedtime evaporates. It hands the child a switch. **Never.**"* |

T4's is the stronger argument and it is the one this design implements: **the cached policy never
expires; staleness changes what the parent is told, never what the agent does.** Recording it because
"independent convergence" was used as evidence, and on the sub-question that most affects the
schema, there was none. `policy_sets.stalenessWarnAfterS` exists; **there is no `stalenessMaxAgeS`,
because there is nothing for it to do.**

### ⚠️ X2 — T4 recommends the exact feature `homecal` has a scar from. **The most dangerous line in the build.**

T4 §6.4 argues for the better-auth API-key plugin partly on the strength of its rate limiting:

> *"better-auth's API-key plugin already provides … and per-key rate limiting (`rateLimitEnabled` /
> `rateLimitTimeWindow` / `rateLimitMax`). **That is the entire feature list we would otherwise
> hand-roll.**"* **[T4 §6.4]**

`homecal`'s auth config disables it, with a comment recording why **[homecal]**: the plugin's default
**10 requests per 24 hours** bricked the Kindle wall display, and — the part that makes this a
landmine rather than a bug — **it surfaces as `401`, not `429`.**

**Now compose that with T4's own failure table:** `401` → `hpc_action: "halt_sync_keep_enforcing"`
**[T4 §4.7]**.

> **The agent makes 1,440 sync requests a day. With per-key rate limiting on at the plugin default,
> it would halt syncing ten minutes after enrolment, permanently, and report itself as *"credential
> revoked"* — while continuing to enforce a policy that can never be updated again.** The device card
> would show `REVOKED`. The parent would re-enrol. It would happen again ten minutes later.

Three mitigations, all cheap, all required:

1. `rateLimit: { enabled: false }` in the `apiKey()` plugin config, copied from `homecal` with its
   comment intact.
2. **Exclude `/api/agent/v1/sync` and `/events` from the `hono-rate-limiter` on `/api/*`** — the same
   trap one layer up, since `homecal` applies that limiter to every `/api/*` path.
3. A boot-time assertion that no live device key has `rateLimitEnabled = true`, and an integration
   test that makes 30 sync calls in a row and asserts 30 × `200`.

**This is the clearest example in the whole project of why reading the sibling app was worth the
time.** T4 recommended the feature from the documentation; `homecal` had already been bitten by it in
production.

### ⚠️ X3 — T8's best mitigation cannot work with T8's recommended delivery mechanism.

T8 §5.4 rates server-side reconciliation as *"⭐ **The one that works**"*:

> *"The server matches each `override.redeemed` to an **issued** `(day, minutes, seq)`. No match →
> `override.unmatched` alert: 'Lucy used a 30-minute code you never issued.'"* **[T8 §5.4]**

But T8 §3.6's recommended delivery is **a static HTML card with `K_ovr` embedded, computing codes
entirely in the browser, saved to the phone's home screen, working with no network** — and its stated
fallbacks are **a printed 30-day card in a drawer** and `openssl dgst -hmac` from a laptop.

**None of those produce an issuance record.** The server can verify that a redeemed code's HMAC is
valid — but a code the child forged from the stolen key verifies *identically*. With no record of
what the parent revealed, **every offline redemption is "unmatched"**, and the alert that was meant
to be the designed response to key theft becomes noise on every legitimate use.

**Resolution (this design):**

1. `override_code_reveals` (§2.7) — the card buffers what it displayed in `localStorage` and flushes
   opportunistically whenever it next has the LAN. That restores the reconciliation for the common
   case at the cost of ~20 lines in the card.
2. **Three verdicts, not two.** `matched` / `unmatched` / **`no_reveal_record`**. The printed-card and
   `openssl` fallbacks land in the third, which is *"we cannot tell"*, not *"she forged it"*.
3. **Wording, and it matters more than the mechanism.** The UI must say *"We have no record that you
   issued this code"* — never *"Lucy used a code you never issued."* On a parenting product, a
   confident false accusation generated by a missing `localStorage` entry is a considerably worse
   outcome than the undetected forgery it was guarding against.

### ⚠️ X4 — T4's auth reasoning assumes TLS; the house ships plain HTTP.

T4 specifies the credential *"presented as `Authorization: Bearer hpc_dk_…` **over TLS**"* and argues
that a token exchange is unnecessary because *"on a TLS-protected LAN, the wire is not the threat"*
**[T4 §6.4]**.

**The house template has no TLS.** `ingress-api.yaml` has no `tls:` block and no annotations; every
host is `http://<name>.arch.internal` on Traefik; `BETTER_AUTH_URL` and `CORS_ORIGINS` in
`values.yaml` are `http://` **[homecal]**. `arch-infra/infra/` — where cert-manager would live — is
an empty directory with a `.gitkeep`.

So the device bearer credential, the enrolment code, `K_ovr` in the desired-state payload, **and the
parent's session cookie** all cross the LAN in cleartext.

**Resolution: accept for v1, but say so out loud.** Under **AR.2** (trusted LAN) and T4's own posture
— *"make it boring to steal rather than hard to steal"* — this is defensible, and diverging from the
house on ingress for one app is worse than the risk it removes. **But T4's sentence should not stand
unexamined**, because someone will later read *"over TLS"* as a description of what was built.
Two notes for the record:

- `K_ovr` is the one payload where this genuinely stings, because it is a long-lived minting secret
  and it moves in a `desired[]` item. If TLS is ever added anywhere, add it here first.
- The upgrade is cheap and self-contained: cert-manager with a self-signed cluster issuer in
  `arch-infra/infra/`, a `tls:` block on this one ingress, and the agent trusting that CA. It would
  benefit every `home*` app, so it belongs as an `arch-infra` issue rather than in this repo.

### ⚠️ X5 — T4 is internally inconsistent about `event_id`, and the inconsistency defeats idempotency.

T4 **R8** specifies the envelope as `{ "event_id": <uuidv7>, … }` **[T4 R8]**. Every worked example in
§4.4 shows `"event_id": "01JB8C3QD5F7H9K1M3P5R7T9V"` — a 26-character Crockford **ULID**.

Those are the same 128 bits in two encodings, which sounds harmless and is not:

> `UNIQUE (device_id, event_id)` is the **only** thing standing between at-least-once delivery and
> double-counted reports **[T4-D8]**. If the agent ever emits one spelling and a replay, a retry or a
> future version emits the other, **the constraint silently stops matching** — two rows, one event,
> no error anywhere, and a report that quietly over-counts.

**Resolution:** the column is `uuid`, and the ingest handler normalises either spelling to the
canonical hyphenated form before insert (§3.1). ⚠️ **Hand this to the agent author as a one-line
contract clarification** — pick one spelling, say which, and put it in `packages/contract`.

### X6 *(known)* — `devices.away_until` was handed back to T6 and never answered.

T4 §9.6 and §14.4 hand T6 a gap: `SILENT_TOO_LONG` has no *"the parent already knows"* exemption, so
it fires benignly every school holiday until the parent mutes the channel — *"which returns the
dead-man's switch to being decorative"* **[T4 §9.6]**. T6 completed **before** T4, so it never saw
the question; `T6-observability.md` contains no answer.

**Adopted as specified**: `devices.awayUntil` (§2.7), forcing `EXPECTED_OFFLINE`, with the constraint
T4 attached — **not** expressed as a policy override, because an away device must still enforce
bedtime the moment it is switched on. One column, one control, one clause.

### X7 *(known)* — T4 §10.5 is withdrawn.

Constraint C1. No `request.extension` event type, no request table, no request inbox, no child-facing
surface (§1, §6.9). Recorded here only so a reader of this document does not go looking for it.

### Minor, resolved in passing

| Item | Resolution |
|---|---|
| T3's endpoints `/api/v1/agent/{enrol,rotate,desired}` vs T4's `/api/agent/v1/*` with no rotate or desired endpoint | T4's paths. Rotation and the version pin both fold into `desired[]` (§4.3) — **zero new endpoints** |
| T3's `/usr/local/etc/homeparentcontrol/credential.json` vs T4's `/var/db/…` | T4's, for consistency with the rest of the agent state dir. Agent-side; no server impact |
| T3's 30-day expiring credential vs T4's durable one with `rotate_after` | T4's. A 30-day hard expiry adds a failure mode whose consequence is "the device goes dark", to defend a secret that is readable by `sudo cat` either way |
| T6's LogQL stream labels `{app=, component=}` vs the chart's `app.kubernetes.io/*` | Not a design conflict — **verify the real label names in `arch-infra/platform/observability/alloy/values.yaml` before writing the alert rules** (§3.4) |
| T4's `deadfall` fires at *"the last known bedtime"*; calendar exceptions move that | **Handed to the agent author.** The deadfall must re-evaluate the full predicate **including `overrides[]`**, or a holiday night with both daemons dead would lock at the baseline time. T4 §8.1 already says it *"re-checks the wall-clock predicate itself"* — this just makes explicit that the predicate includes overrides |

---

## 8. Decisions register

| # | Decision | Rationale |
|---|---|---|
| T5-D1 | `household → child → device`, with `policy_set` between child and device and `household_id` on every row | P2.4. Policy is authored per **child** and compiled per **device**, which is what makes a second Mac a five-second operation |
| T5-D2 | **No singleton anywhere.** The first household is claimed at first run, reusing `homecal`'s `databaseHooks.user.create.before` | A migration-seeded singleton is a hardcoded identity in a costume |
| T5-D3 | The child is a **domain** row, never an auth subject | P0.3 becomes an absence in the identity model rather than a UI rule a stray route can violate |
| T5-D4 | **Authoring state normalised; the wire artefact immutable, content-addressed and signed** | A JWS over re-serialised JSON is a signature over nothing; a JSONB blob has no invariants; rollback needs history |
| T5-D5 | The compiler is a **pure function**, and emits nothing when the document hash is unchanged | Kills daily recompile churn and ETag flapping; makes the riskiest logic testable with no database |
| T5-D6 | **Calendar exceptions compile into `policy.overrides[]`** | A holiday *is* a bounded relaxation. Zero new agent capability, mandatory `expires_at` for free, and it shows up in the audit trail where a parent can see it |
| T5-D7 | `date-holidays` called **live** at compile time, reusing `homecal`'s service file. `calendar_exceptions` stores parent intent only, including `dismiss_holiday` | A persisted mirror of a pure function creates idempotency, staleness and duplication problems for nothing |
| T5-D8 | 21-day exception compile horizon | Bounded wire size, and a Mac offline longer than that converges **stricter** — T4-D7's property, for holidays too |
| T5-D9 | **Three override tables**: `overrides` (compiled) / `override_redemptions` (history) / `override_code_reveals` (reconciliation) | T8-D13 made structural. One table with a discriminator is one forgotten `WHERE` away from re-arming a spent grant |
| T5-D10 | `overrides.expiresAt` is `.notNull()` | T4-D7 as a database constraint. No column exists in which to store "forever" |
| T5-D11 | `schedule_windows.action` carries a `CHECK` — **the one deviation from the house's no-DB-enums convention** | T4-D26. This is the column that can power off a child's computer; its domain does not belong in a Zod schema living inside the process that might have the bug |
| T5-D12 | `schedule_budgets` ships **empty**, `meter` defaulting to `active_s` | D.4 becomes a feature flag, and T4-D27's verdict is recorded where it cannot be forgotten |
| T5-D13 | `uuid` PKs, following the house — a deliberate cosmetic deviation from T4's prefixed-ULID examples | P3.4 is an owner requirement; the ID spelling is not. The wire field is a JSON string either way |
| T5-D14 | `event_id` is `uuid` and the ingest **normalises** ULID-or-UUID | Conflict X5. The idempotency key must not depend on which spelling arrived |
| T5-D15 | Projection is **scheduled, watermarked on `received_at`, and recomputes whole buckets** | Idempotent under arbitrary backlog lateness with no per-row bookkeeping, and immune to a stepped client clock |
| T5-D16 | **`RAW_SAMPLE_RETENTION_DAYS` > the agent's `max_queue_age_days`**, asserted at boot | Otherwise a long outage delivers events that are pruned before projection — stored, then evaporated, with no error |
| T5-D17 | `agent_status` is a **log line** (Loki) plus **interval rows** (Postgres) — not a row per device per minute | T6's alerting reads a Loki stream, so nothing changes there; the table drops from 1,440 rows/day to ~8 and stops being the largest thing in the database |
| T5-D18 | `usage_daily` keyed on the **local** day in `policy.timezone` | Otherwise Sunday evening reports as Monday — the first thing a parent notices, the last thing anyone checks |
| T5-D19 | `SUM(active_s)` is the correct daily total because only one app is frontmost at a time | Stated in the schema so nobody "fixes" it |
| T5-D20 | No partitioning; prune with `DELETE` + a BRIN index. Revisit above ~50 M rows | ~730 k rows/year. Partitioning would buy a `DROP TABLE` and cost real Drizzle friction |
| T5-D21 | Every gap is a **positive record** — `queue.evicted` projected into `enforcement_log`, silence rendered as a hatched band | Zero usage and no data look identical on a bar chart and mean opposite things |
| T5-D22 | Single-use enrolment via conditional `UPDATE … WHERE consumed_at IS NULL RETURNING` | Atomic under any concurrency, no lock, no isolation level to get wrong |
| T5-D23 | **Enrolments target an existing `device_id`** | Makes re-enrolment after a wipe preserve the child's whole history rather than orphan it |
| T5-D24 | **Same-code + same-hardware retry re-issues rather than 409s** | Turns the most likely LAN failure from a phone call into a working retry. Four guards, any one missing → 409 |
| T5-D25 | Hardware-UUID change on re-enrol: **accept and raise a tripwire**, do not refuse | Under AR.1 the likely explanation is a repair; refusing strands the parent mid-fix. Recorded as a choice so it can be flipped in one line |
| T5-D26 | **One `isService` user per household owns every device API key** | `apikeys.userId` is `NOT NULL ON DELETE CASCADE` — hanging keys off a human parent means deleting them silently revokes every Mac |
| T5-D27 | `rateLimit: { enabled: false }` on `apiKey()`, agent routes excluded from `hono-rate-limiter`, asserted at boot and in a test | Conflict X2. Otherwise the agent halts syncing ten minutes after enrolment and reports itself as revoked |
| T5-D28 | RFC 9457 `problem+json` + `hpc_action` on agent routes only; the house's flat `{error}` on parent routes | `hpc_action` decides whether the agent backs off, re-enrols, halts sync or decommissions. Two error shapes, split by route prefix |
| T5-D29 | In-process `setInterval` schedulers, `replicaCount: 1`, `strategy: Recreate` | **The house already solved this.** If replicas ever exceed 1, the liveness job needs `pg_try_advisory_lock` |
| T5-D30 | Agent version pin is a **`desired[]` item of `kind: "agent_version"`**, sourced from `api.env.AGENT_DESIRED_VERSION` in `arch-infra`'s existing `helm.parameters` | Delivers T3's GitOps story with **zero new endpoints and zero template changes**, and inherits T4's reconciliation properties. `git revert` is the rollback |
| T5-D31 | **Containers bump on every `main` push; the agent bumps only on a `v*` tag** | T3's shadow-mode soak and attended supervisor upgrades both require agent releases to be deliberate |
| T5-D32 | The offline card is a **download**, not a route | A bookmark points at the cluster; the card exists for when the cluster is gone |
| T5-D33 | `offlineCodesEnabled` defaults **false** | The whole offline path depends on V-T8.1, which has never been observed working and has no fallback surface. Everything else is built so flipping it is a toggle |
| T5-D34 | **One `reportQuery()`, four sinks.** `notifications` and `digests` tables exist on day one | D.2 becomes a config flag and one adapter, never a second query implementation that drifts |
| T5-D35 | A stored digest renders from its **stored payload**, never by re-running the query | Otherwise last week's email and last week's archived page disagree after any projector fix |
| T5-D36 | `confirm_immediate_effect` guards **tightenings only** | T8/C3. Firing on every grant trains the parent to click through the guard in exactly the case it was built for |
| T5-D37 | `casing: "snake_case"` (following `homework`, the newest generation), verified against better-auth on day one | The newest sibling is the direction of travel; the untested seam is 15 minutes to check and a schema rewrite to get wrong later |
| T5-D38 | `packages/contract` as a separate workspace package, `.strict()` banned by lint | T4 R9 and R1. Coupling wire shapes to Drizzle is how "the payload evolves later" becomes "every payload change is a migration" |

---

## 9. Open questions and what to verify

Nothing here blocks starting the build. Items 1–4 are cheap and should be done in the first day.

| # | Item | Cost | Consequence if skipped |
|---|---|---|---|
| **1** | ⚠️ **Verify `casing: "snake_case"` against better-auth's drizzle adapter** — sign up, create a session, mint an API key, then `\d+ sessions` and confirm `user_id` not `"userId"` | 15 min | Untested in this house (`homework` has no auth). Discovering it at migration 0006 means regenerating every migration |
| **2** | ⚠️ **Assert the agent rate-limit carve-outs** — an integration test making 30 consecutive `/sync` calls and asserting 30 × 200 | 20 min | Conflict **X2**. The failure looks like "credential revoked", ten minutes after enrolment, forever |
| **3** | **Confirm the real Loki stream labels** in `arch-infra/platform/observability/alloy/values.yaml` before writing T6's five alert rules | 10 min | T6's rules assume `{app=, component=}`; the chart labels pods `app.kubernetes.io/*`. Wasted hour, silently wrong alerts |
| **4** | **Create the `arch-infra` Application CR and the `ARCH_INFRA_TOKEN` secret before trusting CI** | 20 min | `bump-arch-infra` soft-skips with `exit 0` when either is missing — **an entirely unwired GitOps chain looks like a green build** |
| **5** | Pin the `event_id` encoding in `packages/contract` and tell the agent author | 5 min | Conflict **X5** |
| 6 | Decide **D.1** (monitoring depth). The schema supports both; the free tier is the default | owner | Rich tier needs the $99, a stable Team ID and pre-provisioned TCC grants, for data Apple is vaulting **[T1, T2]** |
| 7 | Decide **D.2** (reporting delivery). §6.7's four sinks all work off one query | owner | Nothing blocks; the tables exist |
| 8 | Decide **D.3** (lock vs shutdown). Already a `CHECK`-constrained column | owner | Five independent arguments now favour `lock` |
| 9 | Decide **D.4** (bedtime vs budget). `schedule_budgets` is seated and empty | owner | Server-side cost is a feature flag; the **agent-side** state machine is real work **[T4 V13]** |
| 10 | **V-T8.1** — `CFUserNotification` text entry from a root daemon | 15 min on the Mac | Gates `offlineCodesEnabled`. Everything server-side is already built for it |
| 11 | ⚠️ Decide whether **X4 (no TLS)** is accepted for v1, and record it | owner | If TLS is ever added, add it to the `K_ovr` path first |
| 12 | Confirm better-auth's `createApiKey` supports the `permissions` shape in T4 §6.4 against the pinned version | 15 min | T4's own **V5**. `homecal` pins `better-auth@^1.4.19`, which has the plugin, but the permissions shape was not exercised there |

### What I am least confident about

Stated plainly, because a design document that sounds uniformly certain is not being honest.

1. **The 21-day exception horizon is a guess.** It trades wire size against how long a holiday
   survives an offline Mac. Nobody has data; 21 days covers a half-term and most of a summer break's
   first half. Easy to change — it is one constant in the compiler, not a schema decision.
2. **`usage_hourly` at `(device, hour, bundle_id)` may be finer than any report needs.** Daily might
   be enough, and hourly costs 7× the rows. I kept hourly because "what was she doing at 11pm on
   Tuesday" is a question a parent will eventually ask and raw is pruned at 90 days. If it proves
   unused, dropping to daily is a retention change, not a migration.
3. **The re-issue-on-retry path (§5.4 ii) is the most novel thing here** and is the one piece with no
   prior-art backing in any track. Its four guards are what make it safe; if any feels loose in
   review, delete the path and accept a `409`. The cost is a phone call, not a bug.
4. **`cpuPctAvg` stored as an integer in basis points** is a small stylistic call that will look odd.
   The alternative is `real`, which invites floating-point aggregation surprises in a column nobody
   will look at closely. Low stakes either way.
5. **I did not read `arch-infra/platform/observability/alloy/values.yaml`**, so every statement about
   how logs actually get labelled in Loki is inference from the chart's pod labels. That is item 3
   above, and it is the largest unverified thing in this document.

---

## 10. Sources

**Internal (read in full):** `needs.md` · `poc2-findings.md` · `raw/T1-telemetry-ceiling.md` ·
`raw/T3-lifecycle-operability.md` · `raw/T4-contract.md` · `raw/T6-observability.md` ·
`raw/T8-parent-override.md`.

**The house template (read in full via `gh`):** `autumnfallenwang/homecal` — `package.json`,
`turbo.json`, `apps/api/{package.json,src/app.ts,src/index.ts,src/auth.ts,src/db/{index,schema}.ts,
drizzle.config.ts,src/lib/logger.ts,src/middleware/*,src/services/holidays.ts,vitest.config.ts}`,
`apps/web/{next.config.ts,components.json,src/lib/auth-client.ts,src/hooks/*}`,
`deploy/{chart/**,Dockerfile.api,Dockerfile.web}`, `.github/workflows/build.yml`, `biome.json`,
`CLAUDE.md`, `.claude/rules/*`. Sibling generations `autumnfallenwang/homework` (newest scaffold,
`casing: "snake_case"`, `src/config.ts`, `knowledge/`) and `autumnfallenwang/homenews`.
GitOps: `autumnfallenwang/arch-infra` — `apps/homecal.yaml`, `bootstrap/root-app.yaml`, README.

**External:** none. Every claim in this document is traceable to one of the above or is labelled
**[INFERENCE]** or **[ARITH]**.

---
name: 01-control-plane-local
status: done
opened: 2026-09-18
---

# Milestone 01 — Control plane running locally

Build the control plane end to end against a local Postgres container, with no dependency on the
k3s cluster. Covers **phases 0–2** of the build order in
[`../design-decisions.md`](../design-decisions.md) §9.

**Why this first:** k3s is unreachable, and nothing in phases 0–2 needs it. The control plane is
also the lower-risk half of the system — it is the fifth app in an established pattern, where
essentially all novel risk sits in the agent and the contract.

## Scope

**Phase 0 — scaffold.** `pnpm`/`turbo` monorepo following `homework`'s newer conventions with
`homecal`'s auth taken wholesale. `apps/api`, `apps/web`, `packages/contract`. Biome, tsconfig,
Dockerfiles.

**Phase 1 — contract package, before either consumer.** Zod schemas for the sync request/response,
the policy document, the events envelope, the enrolment pair, and the `problem+json` + `hpc_action`
shape. `event_id` pinned to **UUIDv7** with its regex — two spellings of the same 128 bits silently
defeat the `UNIQUE(device_id, event_id)` idempotency key. JSON-Schema emitter wired into CI for the
Swift side.

**Phase 2 — control plane core.** Schema and migration 0001; parent auth (session) and agent auth
(`x-api-key`); the policy compiler as a pure function with a golden-file suite; `POST /enroll`,
`POST /sync`, `GET /policy`, `POST /events`, `GET /health`; projection, rollups and the nightly
prune.

## Exit criteria

- [x] `curl` can enrol a fake device, fetch a signed policy, post events, and read them back
      projected — **entirely on a laptop, no cluster**. Verified end to end 2026-09-20: enrol →
      201 + JWK · `GET /policy` → JWS that verifies against only that JWK · 7 events → 202 ·
      projector → `usage_hourly`, `usage_daily` (local day), `enforcement_log` with human
      summaries, `session_spans` with an open span
- [x] Policy compiler golden-file suite passes; the compiler is a pure function that emits nothing
      when the content hash is unchanged
- [x] `lint`, `typecheck` and `test` all green via the `devkit-*` skills
- [x] Migrations apply cleanly from empty — **verified 2026-09-20** against a fresh database:
      29 tables, both migrations recorded, the three dropped `users` columns absent, X12's
      `shutdown_grace_s BETWEEN 60 AND 3600` present

## Traps to clear deliberately

These are known defects found during research. Each has bitten someone already.

- ⚠️ **X2 — the rate-limit trap.** better-auth's per-key limiter defaults to 10 req/24h and
  surfaces as **401, not 429**. `homecal` disables it with a scar comment after it bricked their
  Kindle. Composed with `401 → halt_sync_keep_enforcing`, the agent would halt syncing ~10 minutes
  after enrolment, **forever**, reporting "credential revoked". Apply the carve-out at **both** the
  plugin level and the row level — `apikeys.rateLimitEnabled` defaults to `true` per row.
- ⚠️ **Service user.** `apikeys.userId` is `NOT NULL ON DELETE CASCADE`, so device keys must hang
  off a per-household `isService` user. Otherwise **deleting a parent silently revokes every Mac.**
  Create it in the same transaction as the household.
- ⚠️ **Retention invariant.** Assert `RAW_SAMPLE_RETENTION_DAYS > max_queue_age_days` at boot, or a
  long agent outage delivers data that is pruned before it can be projected.
- **B1** — verify `casing: snake_case` × better-auth **before** writing migration 0002.
- **No child-facing surface anywhere.** T4 §10.5's "Ask for more time" button is withdrawn.

## Dev environment (decided 2026-09-18)

Everything through phase 4 runs on the **MacBook Air, entirely local** — Docker Postgres, `apps/api`
and `apps/web` on localhost, and the agent pointed at `localhost`. That the agent does not care
whether its control plane is local or in the cluster is hypothesis **H1** paying off.

The Arch desktop stays the **deploy** target (phase 5). It cannot host a macOS test VM — arm64 macOS
virtualizes only on Apple Silicon hosts — so no macOS work moves there regardless of its specs.

✅ **Cluster reachable from the Mac on the home LAN** (verified 2026-09-20): `argocd.arch.internal`
and `grafana.arch.internal` open in a browser with no VPN, and `kubectl` works after copying the
kubeconfig with its server URL rewritten. See [[arch-cluster-access]]. Use it to **observe**, not to
deploy — shipping is still `git commit`.

Enforcement is developed with the **shutdown rung stubbed at compile time** (see the dev-mode
corollary in `../design-decisions.md`). Warnings, lock and the grace timer are exercised for real on
the Air. One scheduled end-to-end on the Mac mini closes it out, once.

## Out of scope

The agent (phase 3), the parent UI (phase 4), and everything cluster-dependent (phase 5 — Helm,
Argo CD, Loki, alerting). The 11 cluster verifications stay blocked until k3s is reachable.

## Progress

- 2026-09-18: Milestone opened. Scaffold, requirements, spec and ADRs in place; no code yet.
- 2026-09-18: X8 and X9 ruled ahead of phase 3 — see ADR 0004. The spec flags these as needing a
  decision before the enforcer is written; that is now unblocked.
- 2026-09-18: **Phase 0 complete.** pnpm/turbo monorepo scaffolded — `apps/api`, `apps/web`,
  `packages/contract` — following `homework`'s conventions. `pnpm install`, `lint`, `typecheck` and
  `test:fast` all green (8 tests, 3 workspaces); `next build` produces standalone output and
  resolves `@hpc/contract` through the `extensionAlias` path; API serves `/health` with structured
  `req_id` logs. Decisions: zod 4 (R9 needs native `z.toJSONSchema()`), newest-of-the-two dep pins,
  `casing: "snake_case"` pending the B1 gate. Dev Postgres on **5433**, not 5432 — homework's dev
  container already claims 5432 on the host.
- 2026-09-18: **Full stack verified end to end.** Docker started, Postgres 17.11 on 5433, `pnpm dev`
  serving api :3001 + web :3000, CORS preflight correct, drizzle client querying the real database,
  both Docker images built and run (non-root `uid=1000`), web rendering contract values from
  `@hpc/contract` inside the container.
- 2026-09-18: ⚠️ **Found and fixed a latent Dockerfile defect inherited from the house pattern.**
  `CMD ["pnpm", ...]` under `USER node` re-downloaded pnpm from npmjs.org on every cold container
  start — and **failed to boot entirely with no network** (exit 1, DNS failure). A `docker restart`
  hides it; k8s creates a new container per pod restart, so it would crashloop during an npm outage.
  Fixed with `COREPACK_HOME` + chown. **`homework` and `homecal` ship the same unpatched file.**
  Captured as [[corepack-runtime-download]].
- 2026-09-20: **Phase 2 step 1 complete — schema, migration and B1.** 29 tables in a single
  `0000_init.sql` (14 rules half, 10 telemetry half, 5 better-auth from `homecal`), 14 CHECK
  constraints, 27 `relations()` blocks. 42 API tests + 9 integration tests against real Postgres.
- 2026-09-20: ✅ **B1 CLOSED — `casing: "snake_case"` works with better-auth.** Signed up, minted an
  API key, signed back in; `sessions.user_id` not `"userId"`, and **zero camelCase columns across
  all 29 tables**. This gate had been open since the project began; `homecal`'s camelCase fallback
  is not needed.
- 2026-09-20: ⚠️ **better-auth pinned to exactly `1.4.19`, no caret.** `homecal`'s manifest says
  `^1.4.19` but its lockfile pins 1.4.19 — and that caret resolves to **1.7.5** today, which
  **moved the apiKey plugin into a separate `@better-auth/api-key` package** and **changed the
  `apikeys` table schema** (it demands a `configId` column 1.4.x never had). Minting a key failed
  outright on 1.7.5. Since §5 says to take `homecal`'s auth wholesale and the entire X2 carve-out
  and service-user flow are written against 1.4.x, the exact pin keeps step 2 as transcription
  rather than porting. **The 1.7.x upgrade is deliberate future work, not a `pnpm update`.**
- 2026-09-20: Applied **X12** (`shutdown_grace_s BETWEEN 60 AND 3600`, not §5.2's `0`) and **X11**
  (no `policy_sets.fail_mode`) over §5.2, consistent with `packages/contract`. Gave `users.color` a
  default — inherited verbatim from `homecal` as `notNull()` with none, which makes the very first
  sign-up fail. Two other `homecal` calendar columns (`holiday_countries`, `receives_daily_digest`)
  are carried unused; whether to drop them is a step-2 decision.
- 2026-09-20: Two process notes. Drizzle numbers migrations from **0000**, not 0001 as planned.
  And I edited `schema.ts` while the subagent writing it was still working — it detected the
  collision and merged both versions. **Wait for the completion signal before touching a file a
  subagent owns.**
- 2026-09-20: **Phase 1 complete.** `packages/contract` defines the wire format — sync request and
  response, the policy document, the events envelope, `problem+json` + the eight `hpc_action`
  values, and the enrolment/health pair. 54 tests. A JSON-Schema artefact
  (`contract.schema.json`, 10 schemas) is emitted for the Swift agent and CI fails if it drifts
  from the schemas.
- 2026-09-20: ⚠️ **Two spec instructions could not be followed as written, both now handled.**
  (1) `z.toJSONSchema()` emits `additionalProperties: false` by default, which would have told a
  generated Swift decoder to **reject** unknown fields — the exact failure R1 exists to prevent,
  and invisible from the TypeScript side because the zod schemas stay tolerant. Fixed with
  `io: "input"` and guarded by a test that walks the artefact. (2) R1 asks for `.strict()` to be
  "banned by lint rule"; biome has no `noRestrictedSyntax`, so the artefact guard replaces it —
  it tests the effect rather than one syntax, and recurses through everything on the wire.
- 2026-09-20: `event_id` uses the spec's **literal lowercase UUIDv7 regex**, not
  `z.uuid({ version: "v7" })`. Zod's helper is case-insensitive and would accept uppercase that
  X5 says must be **rejected, not normalised**. Caught while verifying the plan's own assumption.
- 2026-09-20: **9 wire shapes are undefined in the spec** — most importantly the entire
  `POST /enroll` request body, plus `rejected_events[]` elements, the `desired[]` item spec,
  `policy_signing_keys[]`, and five sync-request enums with one example value each. Modelled
  conservatively as open/opaque with TODOs rather than invented, since R2 forbids renaming later.
  Applied X11 (no `fail_mode`) and X12 (`shutdown_grace_s` min 60) over §4.3, which predates both.
- 2026-09-20: **Cluster surveyed from the Mac** — k3s v1.35.4 up 133 d, Argo CD healthy, GitOps chain
  proven (`homework`'s pinned tag == its repo HEAD). Two of T6's eleven cluster verifications
  resolved: **C2 ✅ Alloy already scrapes pod stdout cluster-wide, so the control plane needs zero
  Loki-specific code**; **C6 ❌ there is no alerting in the cluster at all** — no rules, no contact
  points, no notifiers, and the three live apps have none either. Recorded in
  [[arch-cluster-access]] and reflected in milestone 05.
- 2026-09-20: **Phase 2 step 5 shipped — projection, rollups, prune, three schedulers. MILESTONE
  COMPLETE.** The projector recomputes whole device-hours on a `received_at` watermark; rollups
  land in local-day buckets; the liveness job owns the five-state machine; the nightly pass
  re-projects 48 h, prunes the ladder and rolls the policy horizon.
- 2026-09-20: 🔴 **Two silent bugs the tests caught, both mine, both invisible in production.**
  (1) The watermark round-tripped through a JS `Date`, which has millisecond precision while
  Postgres `timestamptz` has microseconds — so the stored watermark landed fractionally *before*
  the row it came from and `received_at > watermark` re-matched that row for ever. The projector
  is idempotent, so nothing would have corrupted; it would simply never have advanced past its
  newest rows, re-doing unbounded work as rising CPU. Both the read and the write now go through
  `::text` at full precision. (2) A full 50,000-row batch could cut *inside* a group sharing one
  `received_at` — and `now()` is the TRANSACTION timestamp, so every row of one batch insert
  shares one. The strict `>` then skipped the remainder permanently. The trailing partial group is
  now deferred to the next run.
- 2026-09-20: **`DEGRADED` was uncomputable as specified.** §7.3 wants a once-a-minute job to read
  eight self-reported conditions; §4.2 says they arrive on `/sync`; the sync handler persisted none
  of them, and a timer reading the database never sees a request body. Added
  `devices.self_reported_reason` (migration 0002), written by sync, read by liveness — one writer
  each, which keeps F2's single-writer ruling intact. ⚠️ `disk_full` remains **unimplementable**:
  nothing on the wire carries free disk space, and `queue.bytes` is queue size, not headroom.
  Thresholds for `clock_untrusted` (60 s skew), `enforcement_failed` (3, borrowed from
  `escalate_after_failures`) and `enforcer_heartbeat_missing` (180 s = 3 ticks) are all invented —
  the spec names the conditions and gives no numbers.
- 2026-09-20: **§7.3 gives five overlapping states and no evaluation order.** Invented and pinned by
  test. ⚠️ `away_until` beats `SILENT_TOO_LONG` even though §7.3 says that state fires
  "regardless" — A.19/X6 says `away_until` exists precisely "so a school holiday cannot make
  SILENT_TOO_LONG fire benignly and get the channel muted", and a stated purpose beats a loose
  adverb. ⚠️ There is also a genuine **hole between 180 s and 10 minutes** that no row covers; the
  job holds the current state there rather than flapping.
- 2026-09-20: **Suppressed the overnight false amber.** §3.8 says the `agent.stopping` that would
  explain a nightly shutdown is routinely lost ("do not build the design on the dying breath
  arriving"), and §7.3's *state* rule requires an expected-online window while its *notification*
  rule does not restate it. Left alone, every night buzzes a phone at 1 a.m. The notification is
  now window-scoped.
- 2026-09-20: **§7.4 reclassification implemented for row 1 only, deliberately.** Rows 2–4 need the
  *previous* `system_boot_time`, which sync has already overwritten and `agent_status_intervals`
  has no column for — and §7.4 asks for those to be surfaced on the health card, not as
  notifications, which is what the `agent_stopped_while_up` tripwire already does from inside sync
  where both values are in scope.
- 2026-09-20: **Defined the event `data` shapes the projector reads** (`packages/contract/src/telemetry.ts`).
  R8 leaves `data` opaque on purpose and ingest still stores anything, but a projection must
  interpret *something* and no event's payload is defined anywhere in the spec. Read tolerantly: an
  event that does not match is stored, counted as unprojectable, and reinterpretable later with no
  migration.
- 2026-09-20: ⚠️ **Two gaps recorded, not closed.** `telemetry.collect`'s default globs exclude
  `agent.*`, `clock.*`, `queue.*`, `policy.*` and `override.*` — an agent obeying its own policy
  would starve 8 of `enforcement_log`'s 14 kinds and never send the `agent.stopping` that
  `EXPECTED_OFFLINE` depends on. Either the default is wrong or `class: audit` bypasses `collect`;
  phase 3 must resolve it before the Swift agent ships. And `enforcement_log.unique(event_id)` is
  stricter than `events`' own `(device_id, event_id)` key — harmless at UUIDv7 odds, cheap to fix
  now, expensive later.
- 2026-09-20: ✅ **B4 CLOSED, and closed properly.** better-auth 1.4.19 not only accepts §5.9's
  `permissions: { device: ["sync", "policy:read", "events:write"] }` shape — it round-trips it
  through `verifyApiKey` and genuinely **enforces** it (an ungranted permission returns
  `valid: false`). So device keys now carry one scope per endpoint instead of full authority, and
  `deviceResolver` checks the scope the route needs, read from the lookup that already had to
  happen. ⚠️ A key with no `permissions` is treated as unscoped-and-allowed so a deploy cannot lock
  out an in-flight device; remove that branch once no such key can exist. Note the ungranted error
  code is `KEY_NOT_FOUND`, which is misleading — do not surface it verbatim.
- 2026-09-20: ✅ **"Migrations apply cleanly from empty" is now observed, not assumed.** It had been
  an open assumption since step 1, because `0001` had only ever been applied on top of an existing
  `0000`. Against a fresh database: 29 tables, 2 migrations recorded, the three dropped `users`
  columns absent, X12's grace CHECK intact.
- 2026-09-20: **Phase 2 step 4c shipped — `POST /events`. STEP 4 IS COMPLETE.** All five endpoints
  exist. Only step 5 (projection, rollups, prune) stands between here and milestone 01.
- 2026-09-20: **The accepted-ids trap, avoided and then proven avoided.** `ON CONFLICT DO NOTHING
  RETURNING` yields only newly-inserted rows, so the implementation that falls out of the SQL is the
  wrong one — and §5.7 is explicit that "a conflicting row is still *accepted*… returning only
  newly-inserted rows would make the agent retry the same batch forever". That failure is silent:
  the agent re-sends, the server accepts, nothing errors, the queue never drains. Falsified per
  [[falsify-the-gate]] — regressing `accepted_event_ids` to `RETURNING`'s output makes the guard
  return `[]` on the second send, exactly the retry-forever shape.
- 2026-09-20: **Added an optional per-event `boot_id`** (additive, R2-safe). `(boot_id, seq)` is the
  only clock-independent ordering key, but the spec puts `boot_id` on the *batch* while the agent's
  queue is durable across reboots — so a post-reboot drain would stamp pre-reboot events with the
  current boot and corrupt the ordering of exactly the events a crash investigation wants. The Swift
  agent does not exist yet, which made this the cheapest moment the fix will ever be available.
- 2026-09-20: **`/events` alone accepts a decommissioned device.** Decommissioning asks the agent for
  a final `agent.decommissioned` audit event, which the strict resolver would have refused — the code
  path rejecting the record of its own action. §5.5 retains **all** telemetry ("the child's history
  is not the device's property"), so `requireDevice` became a two-policy factory: `/sync` and
  `/policy` still refuse, telemetry does not.
- 2026-09-20: **`class` is the one narrow exception to R8's never-reject.** An unknown `type` is
  stored verbatim and counted; an unknown `class` is rejected, because the retention ladder is keyed
  on it (sample 90 d, audit 400 d) and anything else creates rows the pruner will never touch.
- 2026-09-20: **Gave `unknown_event_type` something to mean.** The spec names the counter and never
  says what "unknown" is measured against. It is now a prefix list mirroring `telemetry.collect`'s
  globs — it does **not** gate ingest, it answers "is the agent sending something we have no
  projection for yet", which is what makes a future backfill discoverable. Both counters ride the
  pino line, since C2 confirmed there is no Prometheus anywhere in the cluster.
- 2026-09-20: ⚠️ **`/events` must not look like a heartbeat.** A.27 says a poisoned batch must never
  make a live agent look silent; the converse is never stated but follows — a draining queue must not
  make a *dead* agent look alive. Asserted, same as `GET /policy`.
- 2026-09-20: **Phase 2 step 4b shipped — `POST /sync` and `GET /api/agent/v1/health`.** The tick
  works end to end: first tick flips `enrolled → active` and returns the full signed policy, second
  tick with a matching ETag returns `unchanged: true` with no payload. **`/events` is all that
  remains of step 4.**
- 2026-09-20: **B2 finally lives where the spec always put it.** The gate has been passing against a
  `/whoami` stub since step 2; it now runs 30 consecutive real `/sync` calls. Falsified on its new
  home before being trusted — re-arming the per-key limiter makes it fail at **exactly 10 × 200**,
  the documented quota, even though each call now also does a scope check, seven tripwire
  comparisons, six writes and a policy read. The `/whoami` version stays as a faster canary that
  isolates the credential path, explicitly labelled as *not* the gate.
- 2026-09-20: **Two documented writers for `health_state`, now one.** §5.2 says the sync handler
  writes it every tick; §7.3 says a liveness job evaluates every device once a minute. Sync writes
  the six factual columns and nothing else. ⚠️ **`health_state` therefore reads `UNENROLLED` even
  after a successful tick** until step 5's liveness job lands. That is correct, not broken, and a
  test asserts it so nobody "fixes" it.
- 2026-09-20: **Cadence trusts the agent's reported boundary.** "Boundary mode" needs the next
  transition, and the only one on the wire is the agent-reported `next_boundary_at`. Recomputing it
  server-side would mean a second DST-correct resolver — unspecified, unscheduled, and free to drift
  against the Swift one. §4.2 already lets the agent shorten its own interval, and cadence is not a
  safety control (enforcement is a separate daemon on an unconditional 60 s tick), so the worst a
  lying agent achieves is polling more often. Clamped to [1s, 300s] server-side, which §4.2 specifies
  only as the *agent's* clamp.
- 2026-09-20: **R4 vs R6 resolved in R6's favour for `desired[]`.** R4 says send a device only what
  it advertised; R6 says an unknown kind must come back `unsupported`, terminal. Pre-filtering would
  satisfy R4 and make R6 unreachable — the item would silently never ship. R4 is applied to
  `server_capabilities`, which is what it is actually about; a kind outside the device's advertised
  set is sent and **logged**. Also: `converged[]` is a claim §4.5 tells the server to ignore, so its
  only live use is carrying `unsupported`; `agent_version` converges on the server's own observation.
- 2026-09-20: **Seven of nine tripwires raised, two deliberately not.**
  `unexpected_source_ip` needs a known-IP baseline no table holds, and `concurrent_boot_ids` has no
  definition anywhere that separates it from `agent_stopped_while_up`. Guessing at either produces a
  banner the parent cannot act on. The seven each have their own test case, because a tripwire that
  never fires is invisible — the same shape as 4a's `attempts` bug.
- 2026-09-20: **Phase 2 step 4a shipped — enrolment, signing and the agent error model.** Step 4 was
  split at the exit criterion's own seam; **the first half now holds end to end**: `curl` enrols a
  device and fetches a signed policy, and the JWS verifies using only the JWK the enrolment response
  handed back. Tampering is rejected. 4b is `/sync`, `/events`, `/health`.
- 2026-09-20: ⚠️ **A safety collision, now closed structurally.** §4.7's status table is global —
  `410 → decommission`, the one `hpc_action` that stops enforcement — while §5.5 uses `410` on
  `POST /enroll` for an expired code, and `/enroll` is the only unauthenticated endpoint in the
  system. Read literally, the single wire signal that stops enforcement was reachable with no
  credential. **Pre-credential responses now carry no `hpc_action` at all**, and a test asserts no
  problem in the registry can emit `decommission`. The contract had recorded this and declined to
  resolve it; it is resolved.
- 2026-09-20: **Unsigned policy now takes an explicit opt-in.** The spec has no signing on/off flag
  and gives `policy_unsigned` no health consequence anywhere — no degraded state, no tripwire, no
  alert — so a control plane that quietly stopped signing was indistinguishable from one that signs.
  Boot refuses without `POLICY_SIGNING_KEY` unless `ALLOW_UNSIGNED_POLICY=1` says so deliberately.
- 2026-09-20: **Four signing blanks filled**, none of them specified: `kid` is the **RFC 7638 JWK
  thumbprint** (the spec gives `kid` no source at all — one env var, no key table);
  `POLICY_SIGNING_KEY` is **PKCS#8 PEM**, with literal `\n` accepted; `policy_signing_keys[]`
  elements are **public JWKs**, typed as plain strings so an agent can skip an `alg` it does not
  know (R1); and problem `type` URIs are rooted at the **API** host — §4.7's one example points at
  the Next.js UI's.
- 2026-09-20: **Two bugs the tests caught, both mine.** (1) `attempts++` lived inside the claim
  transaction that then throws, so every rejection rolled the counter straight back and an enrolment
  code could never burn — the counter now lives outside any transaction that can fail. (2) Agent
  401s returned the parent's flat `{error}`, carrying **no `hpc_action`** — which is exactly the X1b
  mapping that matters most. `resolveSession` now holds the shared logic and each sub-app shapes its
  own failures.
- 2026-09-20: **`session.id` IS the API key's id** on better-auth 1.4.19 — measured against
  `verifyApiKey().key.id`, not documented anywhere. That is how `requireDevice` resolves the caller
  in one lookup instead of a second verification. If a future version changes it the lookup finds
  nothing and the caller gets 403 (fail-closed, enforcement continues per X1b), and
  `policy.integration.test.ts` pins the equivalence so it breaks in CI rather than in production.
- 2026-09-20: ⚠️ **`GET /policy` must never look like liveness.** §4.5 says operators poll it "with
  `curl` constantly" and A.26 makes the tick the heartbeat — so if a read there touched
  `last_sync_at`, an operator curling a dead device's policy would keep it looking HEALTHY. The spec
  never says this; a test asserts the device row is byte-identical across 200, 304 and 404.
- 2026-09-20: ⚠️ **No key rotation exists in the spec.** `policy_signing_keys[]` is an array, but it
  is delivered only in the enrolment response, which an enrolled agent never fetches again — so
  there is no channel to give a rotated key to a running device. Not built; recorded so it is not
  discovered during a rotation.
- 2026-09-20: **Phase 2 step 3 — the policy compiler shipped.** Three layers, because §9's "pure
  function" and the milestone's "emits nothing when the content hash is unchanged" cannot both be
  true of one function: `gather` (DB + live `date-holidays`) → `compilePolicy` (pure, 14 golden
  files) → `publishPolicy` (hash, compare, insert or skip). **Holidays resolve in `gather`, not in
  the compiler** — otherwise every golden file rots on a library bump or a year rollover, which is
  the trap the spec's own purity claim walks into.
- 2026-09-20: **The churn-killer was dead code as specified.** §5.6 compares the new hash against
  the stored one, but §4.3's document carries `policy_version`, `issued_at` and `not_before`, all of
  which change every compile — so the comparison could never be true and the exit criterion was not
  merely unmet but *unmeetable*. `contentHash()` excludes exactly those three. Named `contentHash`
  rather than `documentHash` so the distinction is visible at the call site.
- 2026-09-20: **Five more compiler silences decided**, all recorded in code: array ordering
  (unspecified, and without it the hash is nondeterministic); `overrides.device_id` absent from
  §5.6's predicate, so a grant scoped to a sibling's Mac leaked into this one's document;
  synthesised override ids must be derived, not random, or every compile churns a version;
  `holidays_enabled` was read by nothing; and `treat_as_weekend`'s minute delta had no formula.
- 2026-09-20: **A golden file caught a real design hole.** `treat_as_weekend` borrows the weekend
  window's start time, which is sensible for another bedtime window and absurd for, say, 13:00–15:00
  quiet hours — it emitted a 570-minute "extension" running hours past the rule it relaxes. Now
  clamped to the window's own duration, where it collapses the window to nothing. That is what the
  suite is for.
- 2026-09-20: **The integration test caught a wire mismatch the goldens could not.** Postgres `time`
  columns return `21:30:00`; the contract's `timeOfDay` is strictly `HH:MM`. Hand-written fixtures
  used `HH:MM`, so only a live database exposed it. Normalised in `compile`, at the one place that
  promises a contract-conformant document.
- 2026-09-20: `db` now gets the `schema` generic, which is what makes step 1's `relations()` blocks
  live — `gather` reads a device, its child, household, windows and warnings in one round trip.
  ⚠️ **Signing deliberately deferred to step 4**; `jws`/`signing_key_id` stay null and the contract's
  unsigned sync-envelope variant carries it. `confirm_immediate_effect` is always `false` — see below.
- 2026-09-20: ⚠️ **Two gaps left open on purpose.** (1) **Nothing recompiles as the 21-day horizon
  rolls**, so holidays past the enrolment date never reach a device. §9 step 5 lists a nightly job
  and calls it only "the nightly prune"; the recompile is written down nowhere. Step 5 owns
  schedulers — this must not be lost. (2) `confirm_immediate_effect` needs a version diff plus a
  second, server-side DST-correct boundary resolver, neither specified nor scheduled, and the
  agent's tick never reads the field. It lands with the `/rules` publish UI in milestone 02.
- 2026-09-20: **Phase 2 step 2 — auth shipped.** Parent (session cookie) and agent (`x-api-key`)
  sub-apps, both mounted single-prefix; `homecal`'s auth lifted near-verbatim. **B2 ✅ closed** — and
  deliberately falsified first: turning the per-key limiter back on makes it fail at exactly
  10 × 200, the documented quota. **X2 places 2 and 3 are in** (`lib/device-keys.ts`,
  `lib/assert-x2.ts`); the boot assertion was proven to refuse start against a hand-inserted armed
  key. Place 4-real (against `/sync`) waits for step 4.
- 2026-09-20: **Measured, correcting the spec's wording**: better-auth 1.4.19's exhausted per-key
  limiter throws an APIError carrying no HTTP status. "401, not 429" is true only of the *raw*
  throw — `lib/auth-errors.ts` is what turns it into an honest 429. That single classifier is the
  difference between the agent halting forever and merely backing off, so it is load-bearing, not
  cosmetic.
- 2026-09-20: **§5.5's first-run claim cannot work as written**, three ways, all resolved in
  `lib/bootstrap.ts`: (1) `user.create.before` runs before the row exists, so it has no id for the
  `household_members` insert — split into `before` (role only) + `after` (the transaction);
  (2) minting the `isService` user through better-auth would recurse *and* would not enlist in the
  transaction — it is a raw drizzle insert, which fixes both; (3) A.21's "insert order" is a
  non-problem, because `users` has no FK to `households`: generating both UUIDs client-side means
  `service_user_id` is never transiently null.
- 2026-09-20: **Did not seed the default windows**, despite §5.5. A `schedule_windows` row needs a
  `policy_set` needs a non-null `child_id`, so seeding one demands inventing a child — exactly the
  "hardcoded identity wearing a costume" §5.1 rule 4 forbids. Values are pinned as
  `DEFAULT_SCHEDULE_WINDOWS` and applied when a real child is created. Chose `lock` over §4.3's
  `shutdown`: a *default* that powers off a machine mid-homework is the wrong default.
- 2026-09-20: **"Signup is closed" had no mechanism** in 2,612 lines — no flag, no column, no
  config. Implemented as a middleware in front of the auth handler, because `disableSignUp` is
  static at init and a database hook cannot tell a public sign-up from an admin `createUser`.
  Owner-created parents (`/api/auth/admin/create-user`) still work.
- 2026-09-20: Dropped `users.color`, `users.holiday_countries` and `users.receives_daily_digest`
  (migration `0001_drop_homecal_user_columns`) — `homecal` calendar/digest columns with no meaning
  here, and `holiday_countries` duplicated the real one on `households`. Owner's call.
- 2026-09-18: Fixed two defects in the devkit-generated skills: `devkit-typecheck` and `devkit-test`
  used bare `pnpm tsc --noEmit` / `pnpm vitest run`, which in a turbo monorepo check nothing and
  find nothing respectively. Both now call the root turbo tasks.

## Outcome

**Closed 2026-09-20.** The control plane runs end to end on a laptop: a device enrols with a
one-time code, receives an Ed25519-signed policy it can verify against a key handed over at
enrolment, ticks, posts telemetry, and has that telemetry projected into usage, enforcement and
session history. 349 tests, `lint`/`typecheck`/`test` green, migrations verified from an empty
database.

**What actually took the time was not writing code.** Every section of the spec larger than about
fifty lines contained at least one thing that could not be implemented as written: §5.5's bootstrap
hook had no user id, §5.6's churn-killer was dead code, §4.7 made `decommission` reachable without
a credential, §7.3's `DEGRADED` had no inputs in the database. None of these were ambiguities to
interpret; they were instructions that would not run. The working method that emerged — treat the
document as a hypothesis, resolve each contradiction explicitly, and record the ruling next to the
code rather than in a doc nobody re-reads — is the thing to carry into milestone 02.

**Four bugs were caught by tests that nearly did not exist**, all silent in production: an
`attempts` counter rolled back by the transaction it was recording a failure for; an
`accepted_event_ids` that would have made the agent re-send for ever; a watermark that could never
advance past its own newest row; and a batch boundary that dropped events sharing a timestamp. The
habit of deliberately breaking a gate to watch it fail — captured as [[falsify-the-gate]] — earned
its place three separate times.

**Carried into later milestones:** no rotation channel for the signing key (delivered only at
enrolment, which an enrolled agent never repeats); `telemetry.collect`'s defaults starve the
projector; `disk_full` is unimplementable as a `DEGRADED` reason; and C6 — there is still no
alerting anywhere in the cluster, so "notified" currently means "logged".

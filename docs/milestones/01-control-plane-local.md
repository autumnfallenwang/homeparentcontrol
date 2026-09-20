---
name: 01-control-plane-local
status: open
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

- [ ] `curl` can enrol a fake device, fetch a signed policy, post events, and read them back
      projected — **entirely on a laptop, no cluster**
- [ ] Policy compiler golden-file suite passes; the compiler is a pure function that emits nothing
      when the content hash is unchanged
- [ ] `lint`, `typecheck` and `test` all green via the `devkit-*` skills
- [ ] Migration 0001 applies cleanly from empty

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
- 2026-09-18: Fixed two defects in the devkit-generated skills: `devkit-typecheck` and `devkit-test`
  used bare `pnpm tsc --noEmit` / `pnpm vitest run`, which in a turbo monorepo check nothing and
  find nothing respectively. Both now call the root turbo tasks.

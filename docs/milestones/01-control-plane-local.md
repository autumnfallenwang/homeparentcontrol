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

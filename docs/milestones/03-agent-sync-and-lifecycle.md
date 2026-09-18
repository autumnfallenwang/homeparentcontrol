---
name: 03-agent-sync-and-lifecycle
status: planned
opened: 2026-09-18
---

# Milestone 03 — Agent: sync, updates and liveness

The networked half. Covers **phase 3 steps 3–5** of
[`../design-decisions.md`](../design-decisions.md) §9.

## Scope

**`sync`** — tick, adaptive cadence (60 s → 15 s near a boundary → 5 s while a parent is in the UI
via `next_poll_after_ms`), `queue.sqlite` store-and-forward, two-class eviction with the synthetic
`queue.evicted` audit event, desired-state reconciliation, credential rotation.

**`supervisor`** — watchdog, pkg staging, digest re-verification, install, offline rollback from the
pkg cache. **Never self-updates.**

**`deadfall`** — the periodic one-shot that enforces if the agent is dead, including the override
clause in its predicate.

## Exit criteria

- [ ] Agent enrols against the local control plane and exchanges its one-time token for a durable
      credential
- [ ] Survives a server outage of several hours and drains its queue without duplicating or losing
      events (idempotency by `event_id`)
- [ ] **Enforcement is provably unaffected throughout** — re-run V6 with sync present
- [ ] Credential rotation completes with the 24 h server-side overlap
- [ ] Supervisor installs a new version, and rolls back from the pkg cache with no network
- [ ] Heartbeat drives the five-state machine correctly, including `EXPECTED_OFFLINE` on clean
      shutdown (SIGTERM at shutdown is ✅ verified on this hardware)

## Traps to clear deliberately

- ⚠️ **X2 — the rate-limit trap.** better-auth's per-key limiter defaults to 10 req/24 h and
  surfaces as **401, not 429**. Composed with `401 → halt_sync_keep_enforcing`, the agent halts
  syncing ~10 minutes after enrolment, **forever**, reporting "credential revoked". Carve-out at
  both plugin and row level. Write B2's test in the same commit.
- ⚠️ **X1b.** A 401 or revoked credential must **not** disable enforcement — that would make
  revocation a bypass.
- ⚠️ **X1c.** A cached policy **never** expires. A TTL is a remotely-triggerable bypass: anyone who
  keeps the agent offline long enough wins.
- ⚠️ **V-PKG-1 before relying on rollback.** `.pkg` downgrade was observed only in the *user*
  domain; `installer -target /` with sudo is untested and the whole rollback story rests on it.
- **The supervisor is the one component that cannot be rolled back in place.** Keep it ~300 lines,
  enforcement-logic-free, and attended on upgrade.
- **Queue vs retention invariant:** raw retention must exceed max queue age, or a long outage
  delivers data that is pruned before projection.

## Out of scope

Parent UI (04) · cluster (05) · real shutdown (06).

## Progress

- 2026-09-18: Opened.

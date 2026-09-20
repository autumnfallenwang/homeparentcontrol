---
name: 03-agent-sync-and-lifecycle
status: open
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

Everything checkable without root is checked. What remains needs a Mac someone is willing to have
locked, and is scripted end to end in [`../../agent/scripts/v-series.md`](../../agent/scripts/v-series.md).

- [x] **Agent enrols against the local control plane** and exchanges its one-time token for a
      durable credential — proven over a socket against Hono and Postgres, not by inspection.
      `agent/scripts/e2e-local.sh`, 9/9 passing.
- [x] **Survives a server outage of several hours** and drains its queue without duplicating or
      losing events (idempotency by `event_id`) — four simulated hours, 240 events through a closed
      port, then drained over the real wire and delivered exactly once. Proven twice: once against
      the store (`QueueTests`) and once against the server (`OutageEndToEndTests`).
- [x] **Credential rotation completes with the 24 h server-side overlap** — and the first
      implementation did not work. See [ADR 0008](../adr/0008-credential-rotation-overlap.md).
- [ ] **Enforcement is provably unaffected throughout** — V6. ⚠️ **Needs the owner.**
- [ ] **Supervisor installs a new version, and rolls back from the pkg cache with no network** —
      ⚠️ **Needs the owner, and V-PKG-1 first.** See the blocker below.
- [~] **Heartbeat drives the five-state machine, including `EXPECTED_OFFLINE` on clean shutdown** —
      the server half is covered by M1's `liveness.integration.test.ts`, including
      `EXPECTED_OFFLINE` after a clean `agent.stopping`. The agent now emits that breadcrumb on
      SIGTERM. The two halves have not been run against each other with a real shutdown, which is
      hardware work.

### Inherited from milestone 02 (moved 2026-09-20)

These three test the enforcer's *interaction* with components milestone 02 explicitly deferred, so
they could never have passed there. V6 in particular was M02's headline and had nothing to boot out.
All three are now scripted with a worked procedure and named failure modes.

- [ ] **V5** — server accepts then hangs 120 s → locks at the boundary, **proving total sync timeout
      < one tick**. The client's budget is 20 s + a 5 s backstop against a 60 s tick, asserted as a
      unit test; V5 is the observation.
- [ ] **V6** — `launchctl bootout system/com.hpc.sync` → **byte-identical enforcer logs** with and
      without sync running. *The direct proof* that enforcement is independent of the network.
- [ ] **V9** — `sudo kill -9` the enforcer with the deadfall installed → the deadfall re-locks,
      **including through an override grant** (the clause §4.6 singles out).

## Traps to clear deliberately

- ✅ **X2 — the rate-limit trap.** better-auth's per-key limiter defaults to 10 req/24 h and
  surfaces as **401, not 429**. Composed with `401 → halt_sync_keep_enforcing`, the agent halts
  syncing ~10 minutes after enrolment, **forever**, reporting "credential revoked". Carve-out at
  both plugin and row level. Write B2's test in the same commit. **Closed, and it grew a fourth
  mint site this milestone:** rotation calls `mintDeviceKey` too, and a rotated key with the flag
  armed would halt sync ten minutes later while reporting itself revoked.
  `credential.integration.test.ts` asserts the flag on the rotated key specifically.
- ✅ **X1b.** A 401 or revoked credential must **not** disable enforcement — that would make
  revocation a bypass. The sync daemon halts and the enforcer is a separate process it cannot
  reach. Asserted end to end: a forged credential yields `halt_sync_keep_enforcing`, never
  `decommission`.
- ✅ **A new one, found here: only `/sync` may honour a `410`.** §4.7's status table is global, but
  `/enroll` returns 410 for a consumed code and is *unauthenticated* — so read literally, anyone
  able to answer a plain-HTTP request (X4) could uninstall the agent. Downgraded to
  `halt_sync_keep_enforcing` everywhere else, matching the server's own `PRE_CREDENTIAL_PROBLEMS`
  guard. Both halves are one comparison each.
- ✅ **X1c.** A cached policy **never** expires. A TTL is a remotely-triggerable bypass: anyone who
  keeps the agent offline long enough wins. Nothing in the sync daemon deletes
  `policy.current.json`; a policy that fails verification is discarded and the cached one is left
  untouched.
- ⚠️ **V-PKG-1 before relying on rollback.** *Still open — see the blocker below.* `.pkg` downgrade was observed only in the *user*
  domain; `installer -target /` with sudo is untested and the whole rollback story rests on it.
- **The supervisor is the one component that cannot be rolled back in place.** Keep it ~300 lines,
  enforcement-logic-free, and attended on upgrade. ✅ Its judgement is in `HPCCore.SupervisorPolicy`
  (pure, 19 tests); the daemon is the hands. It reads the enforcer's `last_decision` — a string the
  enforcer already computed — rather than evaluating a policy, which is what keeps it
  enforcement-logic-free while still deferring an install during a lock.
- ✅ **Queue vs retention invariant:** raw retention must exceed max queue age, or a long outage
  delivers data that is pruned before projection. Asserted at boot and nightly by
  `assertLiveRetentionInvariant`; the agent's side keeps audit events for 90 days against a
  sample's 14, so a long outage sheds usage detail and keeps every enforcement action.

## ⚠️ The blocker

**V-PKG-1 gates the supervisor's exit criterion, and it is not a coding question.**

`.pkg` downgrade was observed only in the *user* domain. §6.4's entire offline recovery path is
`installer -pkg pkgs/<last-good>.pkg -target /` as root, and that has never been run. If root-domain
`installer` refuses to go backwards, the supervisor cannot roll back, and every row of §6.4's
recovery table claiming "No human? No network? < 1 min" is wrong.

What changed this milestone: **there is now a package to test with.** `agent/scripts/build-pkg.sh`
produces a real, verified `.pkg` (4 binaries, 3 plists, a postinstall that deliberately does not
restart the supervisor — A.24). Before it, the pkg cache was empty by construction and there was
nothing for a rollback to roll back *to*, so the criterion could not have been attempted at all.

It is a ~20 minute run with sudo, scripted in `v-series.md`. **If it fails, do not work around it
locally** — the alternatives are a versioned-directory layout with a symlink swap (which E.2
simplified away) or a forced install, and choosing between those is an ADR.

## Out of scope

Parent UI (04) · cluster (05) · real shutdown (06).

## Progress

- 2026-09-18: Opened.
- 2026-09-20: **Took V5, V6 and V9 from milestone 02.** They test the enforcer against the sync
  daemon and the deadfall, both of which M02's scope defers to here — V6 is M02's headline exit
  criterion and there was nothing to `launchctl bootout` until a sync daemon existed.
- 2026-09-20: **Pure core** — cadence, queue eviction, desired-state reconciliation, deadfall
  schedule, supervisor judgement. 65 tests. Four traps the tests found rather than the spec stating:
  eviction needs hysteresis or it evicts one row per pass for ever; the deadfall's calendar entries
  are read in the *system* zone while A.30 says the *policy's* wins; the supervisor treated the
  cached last-good pkg as an upgrade candidate and would downgrade a healthy agent; and
  `staleConfirmations` still let an upgrade install onto a machine one tick from unhealthy.
- 2026-09-20: **Deadfall and supervisor**, with the I/O layer moved into a shared `HPCAgentIO` so
  the deadfall reads exactly one policy through exactly one code path.
- 2026-09-20: **Sync daemon** — `queue.sqlite`, the client, the spool drain. Event ids had to become
  *derived* rather than generated: a crash between `enqueue` and `unlink` re-parses a segment, and a
  random tail would store one enforcement action twice under two ids.
- 2026-09-20: **Credential rotation**, server and agent. Writing the test found the overlap did not
  work — the old key authenticated but `deviceResolver` matched only `api_key_id`, returning the
  403 the overlap exists to prevent. [ADR 0008](../adr/0008-credential-rotation-overlap.md).
- 2026-09-20: **End to end against a real control plane.** 9/9, including a four-hour outage
  delivered exactly once. `agent/scripts/e2e-local.sh`.
- 2026-09-20: **`build-pkg.sh`** — the package the supervisor installs and rolls back from, which
  did not exist and without which V-PKG-1 could not be attempted.

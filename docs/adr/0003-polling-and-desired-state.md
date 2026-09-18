# 0003 — Agent-initiated polling with desired-state reconciliation

- **Status:** accepted
- **Date:** 2026-09-18
- **Deciders:** project owner (captured during POC 2)

## Context

[0002](./0002-split-agent-and-control-plane.md) put an autonomous agent on the child's Mac and the
control plane in k3s. This ADR records how they talk.

One interaction in the whole system is genuinely latency-sensitive: **the parent grants 30 extra
minutes at 21:29 and wants it to take effect now.** With a fixed 60-second poll the child can stare
at a lock screen for up to a minute after the grant — annoying, and exactly the moment the system's
credibility is being judged. That single case is the entire argument for push, so POC 2's contract
track (T4) tried to falsify the polling hypothesis against it rather than assume it away.

The second question was shape rather than transport: does the server send the agent **commands** to
execute, or **state** to converge on? T4's first draft kept a small RPC command channel — five verbs
— alongside the declarative policy.

## Decision

**Agent-initiated polling with an adaptive cadence, and desired-state reconciliation. No push, no
long-poll, and no RPC command channel** (A.5, A.6).

The agent has exactly one timer, and everything below is that timer changing its period. **The
server owns the cadence** — every response carries `next_poll_after_ms`, which the agent clamps to
`[1000, 300000]`. The agent's own boundary logic can only ever *shorten* the interval, never lengthen
it, so a server bug cannot slow the agent past five minutes and a cold policy cannot make it hammer.

| Mode | Period | Entered when |
|---|---|---|
| `base` | 60 s | default — 1,440 req/day on a LAN |
| `boundary` | 15 s | within `poll.boundary_lead_s` (900 s) of the next warn-or-enforce transition |
| `attended` | 5 s | a parent has the device page open — a server-side 10-minute sticky flag |
| `backoff` | 1 s → 300 s, full jitter | consecutive sync failures; `Retry-After` always wins |

**Worst-case grant latency is ~5 s, with zero new components and no inbound port.** Because sync and
enforcement are separate daemons, backoff can never slow enforcement; the enforcer's 60 s tick is
unconditional.

| Rejected | Worst-case latency | What it costs |
|---|---|---|
| Fixed 60 s poll | 60 s | nothing — but it loses the one interaction that matters |
| **Outbound long-poll / SSE** | ~1 s | a held connection, reconnect logic, ingress idle-timeout tuning — **a second network failure path to reason about** |
| **True server push** | ~1 s | an HTTP listener, stable address/DNS, firewall rule and TLS server cert **on the child's Mac**; the server must track reachability. Directly contradicts [0002](./0002-split-agent-and-control-plane.md) |
| **RPC command channel** | — | retry, ack, expiry and dead-letter machinery — **and a missed command is simply lost** |

📄 **Apple's own prior art argues for polling.** MDM does not push content: APNs sends a
content-free wake-up carrying only a `PushMagic` string, and the device then *polls* the MDM server
for the queued command. The push exists solely to wake a sleeping device — and our agent is already
awake every 60 seconds. Pushing would be building APNs to solve a problem we do not have.

**Desired state replaced the command channel outright.** T7 found that the nearest existing project,
`mac-screentime-enforcer`, drives a Mac from a *retained* desired-state flag the agent reconciles
continuously rather than from RPC — so a missed message is self-healing. T4 adopted that in full and
**deleted its own command channel**: two of the five verbs were RPC dressing, and three were
re-expressed as desired state with convergence *observed* rather than acked. `force_policy_refetch`
existed only to defeat caching, which is meaningless when the agent re-evaluates every tick;
`set_log_level` was configuration masquerading as a command and moved into the policy document.
⚖️ It is also the direction Apple moved MDM with DDM, and — the argument that actually landed for
this owner — **it is how Argo CD already works on his cluster**: declare the state, let the thing
converge, observe the result.

Reconciliation rules, which are the whole point: items are idempotent by `desired_id`; they are
**re-sent every tick until converged**, so there is no retry policy, no expiry and no dead-letter
handling because there is no delivery to fail; the server removes an item when it **observes**
convergence, not when the agent claims it; an unknown `kind` is reported as `unsupported`, never
silently ignored.

## Consequences

**Positive**

- The fast polling sits exactly where the human is, and costs ~120 extra requests per parent session
  on a LAN. **95% of push's benefit for 0% of its cost.**
- A dropped response, a crashed agent mid-action, or a reboot all self-heal on the next tick. There
  is no state machine tracking whether a message arrived.
- **The tick is also the heartbeat** (A.26), so liveness needs no second endpoint — and a second
  liveness path could be healthy while the real one is broken.
- Telemetry is deliberately *off* the tick, on `POST /events` (A.27): a 413, a 429 or a poisoned
  batch must never make a live, enforcing agent look silent.
- The upgrade path is additive and recorded so the decision stays reversible: a `GET …/wait` long-poll
  that agents opt into by advertising `sync.longpoll`. No endpoint changes, no inbound port.

**Negative**

- ⚖️ **Latency is a floor, not a guarantee.** ~5 s assumes the parent has the device page open. A
  grant issued from the dashboard without opening the device lands in up to 15 s at `boundary`
  cadence, or 60 s outside it.
- **The parent UI must not claim success on its own write.** "Applied" has to be driven by the
  agent's next tick reporting the new `policy_version` and a shifted boundary. Claiming success on
  the write is precisely the *"the server thinks it delivered"* failure that polling was chosen to
  avoid — which means extra UI state (`Sent ✓` → `Applied ✓`) that a push design would not need.
- 1,440 requests/day per device forever, most of them returning "nothing changed". Cheap on a LAN,
  and rate limiting is the danger: ⚠️ the house's better-auth default (10 req/24 h) **surfaces as a
  401, not a 429**, which composed with `401 → halt_sync_keep_enforcing` would silently halt syncing
  ~10 minutes after enrolment, forever, reporting "credential revoked". The carve-out is mandatory.
- Convergence-by-observation means the server carries per-device desired-state bookkeeping it would
  not need if it could simply fire and forget.

**Open risks**

- 📄 The APNs/MDM-polls-anyway argument is documented, not tested. It is corroborating, not
  load-bearing — the four other reasons stand without it.
- ⚠️ `attended` mode depends on a server-side sticky flag set by opening a page. If that flag is
  ever wrong, the 5-second promise quietly becomes 60 and nobody notices until a grant feels slow.

## Notes

- T4 §10.5 proposed an *"Ask for more time"* button on the warning modal to hide the remaining
  latency behind the parent's thumb. **It was withdrawn** — P1.5 forbids a request flow from the
  child. See [0007](./0007-online-only-override.md).
- Sources: [`poc2-findings.md`](../research/poc2-findings.md) §3 (T4, T7), §5 H2 ·
  [`T4-contract.md`](../research/tracks/T4-contract.md) §2, §4.6, §10 ·
  [`T7-prior-art-screentime.md`](../research/tracks/T7-prior-art-screentime.md) §1.1, §3 ·
  [`design-decisions.md`](../design-decisions.md) A.5, A.6, A.26, A.27, §4.2, §5.4.
